import { mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { cli, define } from 'gunshi'
import { devCommonArgs, devSubCommands, normalizeDevArgs } from '@pluxel/agent-sdk/internal/cli'
import {
	controlSha256,
	encodeControlData,
	renderPluginDescriptors,
	verifyPluginControlMaterial,
} from '@pluxel/host/internal/control-manifest'
import {
	createPluginControlMaterialReader,
	type PluginControlMaterialsSnapshot,
} from '@pluxel/host/internal/agent/runtime'
import { compileScript } from '@pluxel/rolldown/scripts'
import { syncPluginControl as writePluginControl } from '../src/client/materials'
import { syncPluginControl } from '@pluxel/agent-sdk/client'
import { createDevFixture } from './helpers/dev-fixture'

const directories: string[] = []
const pendingCompilations = new Set<ReturnType<typeof compileScript>>()
let compilationController: AbortController | undefined
afterEach(async () => {
	try {
		// Vitest timing out does not cancel the compiler's native child process.
		compilationController?.abort()
		await Promise.allSettled(pendingCompilations)
	} finally {
		compilationController = undefined
		pendingCompilations.clear()
		process.exitCode = 0
		vi.restoreAllMocks()
		await Promise.all(
			directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
		)
	}
})
async function fixture(
	options: Readonly<{
		materialExportName?: string
		packageName?: string
		canonicalExportName?: string
		entry?: PluginControlMaterialsSnapshot['definitions'][number]['definition']['entry']
	}> = {},
) {
	const directory = await mkdtemp(join(tmpdir(), 'pluxel-control-sync-'))
	directories.push(directory)
	const dependencies = join(directory, 'node_modules/@pluxel')
	await mkdir(dependencies, { recursive: true })
	for (const name of ['core', 'host', 'agent-sdk'])
		await symlink(resolve(import.meta.dirname, `../../${name}`), join(dependencies, name), 'dir')
	await writeFile(
		join(directory, 'package.json'),
		JSON.stringify({ private: true, type: 'module' }),
	)
	const exportName = options.materialExportName ?? options.canonicalExportName ?? 'Counter'
	const definition = {
		entry: options.entry ?? {
			kind: 'package-root' as const,
			packageName: options.packageName ?? '@test/synced-counter',
		},
		exportName: options.canonicalExportName ?? 'Counter',
	}
	const contracts = { config: `sha256:${'a'.repeat(64)}`, instance: `sha256:${'b'.repeat(64)}` }
	const files: Record<string, string> = {
		'index.mjs': renderPluginDescriptors([
			{ exportName, descriptor: { format: 2, definition, contracts } },
		]),
		'index.d.mts': `import type { PluginDescriptor } from '@pluxel/host/internal/agent-types';\ndeclare class ${exportName}Instance { count: number; add(delta: number): number }\nexport type { ${exportName}Instance };\nexport type ${exportName}ConfigDeclaration = readonly [{ readonly expression: 'schema' }];\nexport type ${exportName}ConfigInput = { step?: number };\nexport type ${exportName}ConfigOutput = { step: number };\nexport declare const ${exportName}: PluginDescriptor<${exportName}ConfigInput, ${exportName}ConfigOutput, ${exportName}Instance>;\n`,
	}
	const entries = await Promise.all(
		Object.entries(files).map(async ([path, content]) => ({
			path,
			size: Buffer.byteLength(content),
			sha256: await controlSha256(content),
		})),
	)
	const unsigned = {
		format: 2 as const,
		compiler: 'script-sync-test',
		definitions: [
			{ definition, exportName, module: 'index.mjs', contracts, source: 'index.d.mts' },
		],
		files: entries,
	}
	const manifest = {
		...unsigned,
		snapshot: `sha256:${await controlSha256(encodeControlData(unsigned))}`,
	}
	files['manifest.json'] = `${encodeControlData(manifest)}\n`
	const snapshot: PluginControlMaterialsSnapshot = {
		catalogRevision: 3,
		materials: [{ snapshot: manifest.snapshot, manifest, files }],
		definitions: [{ definition, snapshot: manifest.snapshot, exportName }],
		unavailable: [],
	}
	return { directory, snapshot, reader: createPluginControlMaterialReader(async () => snapshot) }
}

it('groups one canonical entry and reports exceptional export aliases without ambiguous types', async () => {
	const fixtures = await Promise.all([
		fixture(),
		fixture({ canonicalExportName: 'Gauge' }),
		fixture({ canonicalExportName: 'CounterConfigInput', materialExportName: 'ConfigPlugin' }),
		fixture({ canonicalExportName: 'default', materialExportName: 'DefaultPlugin' }),
	])
	for (const item of fixtures) item.reader[Symbol.dispose]()
	using source = createPluginControlMaterialReader(async () => ({
		catalogRevision: 9,
		materials: fixtures.flatMap((item) => item.snapshot.materials),
		definitions: fixtures.flatMap((item) => item.snapshot.definitions),
		unavailable: [],
	}))
	const result = await writePluginControl({ source, out: join(fixtures[0].directory, 'grouped') })
	expect(new Set(result.definitions.map((entry) => entry.module)).size).toBe(1)
	expect(
		result.definitions.find((entry) => entry.definition.exportName === 'Counter')?.exportName,
	).toBe('Counter')
	expect(
		result.definitions.find((entry) => entry.definition.exportName === 'Gauge')?.exportName,
	).toBe('Gauge')
	const names = result.definitions.flatMap(({ exportName }) => [
		exportName,
		...['ConfigDeclaration', 'ConfigInput', 'ConfigOutput', 'Instance'].map(
			(suffix) => exportName + suffix,
		),
	])
	expect(new Set(names).size).toBe(names.length)
	for (const canonicalName of ['default', 'CounterConfigInput'])
		expect(
			result.definitions.find((entry) => entry.definition.exportName === canonicalName)?.exportName,
		).toMatch(/^Plugin_[a-f0-9]{64}$/)
	const declaration = await readFile(
		result.definitions[0].module.replace(/\.mjs$/, '.d.mts'),
		'utf8',
	)
	expect(declaration).toContain('Gauge as Gauge')
	expect(declaration).toContain('DefaultPlugin as Plugin_')
})

it('keeps long source-entry identities within material path budgets and reports unavailable definitions', async () => {
	const sourcePlugin = await fixture({
		entry: {
			kind: 'source-entry',
			sourceSpace: 'application',
			path: 'nested/'.repeat(200) + 'counter.ts',
		},
	})
	using original = sourcePlugin.reader
	const result = await writePluginControl({
		source: original,
		out: join(sourcePlugin.directory, 'long-source'),
	})
	expect(result.definitions[0].definition.entry).toEqual(
		sourcePlugin.snapshot.definitions[0].definition.entry,
	)
	expect(result.definitions[0].module).toMatch(/entries\/[a-f0-9]{64}\/index\.mjs$/)
	using unavailable = createPluginControlMaterialReader(async () => ({
		catalogRevision: 10,
		materials: [],
		definitions: [],
		unavailable: [sourcePlugin.snapshot.definitions[0].definition],
	}))
	const empty = await writePluginControl({
		source: unavailable,
		out: join(sourcePlugin.directory, 'unavailable'),
	})
	expect(empty).toMatchObject({ catalogRevision: 10, unavailableCount: 1, definitions: [] })
	expect(empty).not.toHaveProperty('entry')
	await expect(readFile(join(empty.out, 'current/index.mjs'))).rejects.toMatchObject({
		code: 'ENOENT',
	})
})

it('keeps canonical imports stable when material aliases and the set of same-name Plugins change', async () => {
	const original = await fixture({ materialExportName: 'Plugin_previous_alias' })
	const other = await fixture({ packageName: '@test/another-counter' })
	using _originalReader = original.reader
	using _otherReader = other.reader
	using together = createPluginControlMaterialReader(async () => ({
		catalogRevision: 4,
		materials: [...original.snapshot.materials, ...other.snapshot.materials],
		definitions: [...original.snapshot.definitions, ...other.snapshot.definitions],
		unavailable: [],
	}))
	const out = join(original.directory, 'stable')
	const first = await writePluginControl({ source: together, out })
	const selected = first.definitions.find(
		(entry) =>
			encodeControlData(entry.definition) ===
			encodeControlData(original.snapshot.definitions[0].definition),
	)!
	expect(first.definitions).toHaveLength(2)
	expect(new Set(first.definitions.map((entry) => entry.module)).size).toBe(2)
	expect(first.definitions.map((entry) => entry.exportName)).toEqual(['Counter', 'Counter'])
	expect(selected.exportName).toBe('Counter')
	expect(await readFile(selected.module.replace(/\.mjs$/, '.d.mts'), 'utf8')).toContain(
		`Plugin_previous_alias as ${selected.exportName}`,
	)

	const renamed = await fixture()
	using renamedReader = renamed.reader
	const next = await writePluginControl({ source: renamedReader, out })
	expect(next.definitions).toHaveLength(1)
	expect(next.definitions[0]).toEqual(selected)
	expect(next.snapshot).not.toBe(first.snapshot)
	expect(await readFile(selected.module.replace(/\.mjs$/, '.d.mts'), 'utf8')).toContain(
		`Counter as ${selected.exportName}`,
	)
})

it('publishes verified entry modules atomically and compiles imports through their stable current paths', async () => {
	const controller = new AbortController()
	compilationController = controller
	const { directory, reader } = await fixture()
	using source = reader
	const out = join(directory, 'control')
	const first = await writePluginControl({ source, out })
	expect(first).not.toHaveProperty('entry')
	expect(first.definitions[0].module).toMatch(/\/current\/entries\/[a-f0-9]{64}\/index\.mjs$/)
	expect(first.definitions).toHaveLength(1)
	expect(await readlink(join(out, 'current'))).toBe(`.snapshots/${first.snapshot.slice(7)}`)
	const manifest = JSON.parse(await readFile(join(out, 'current/manifest.json'), 'utf8'))
	const files: Record<string, string> = {}
	for (const file of [
		'manifest.json',
		...manifest.files.map((entry: { path: string }) => entry.path),
	])
		files[file] = await readFile(join(out, 'current', file), 'utf8')
	await expect(verifyPluginControlMaterial(manifest, files)).resolves.toMatchObject({
		snapshot: first.snapshot,
	})
	expect(
		files[
			first.definitions[0].module.slice(join(out, 'current').length + 1).replace(/\.mjs$/, '.d.mts')
		],
	).toContain(`CounterConfigDeclaration as ${first.definitions[0].exportName}ConfigDeclaration`)
	await expect(writePluginControl({ source, out })).resolves.toMatchObject({
		snapshot: first.snapshot,
		out: first.out,
	})
	await writeFile(
		join(directory, 'tsconfig.json'),
		JSON.stringify({
			extends: resolve(import.meta.dirname, '../tsconfig.json'),
			compilerOptions: {
				lib: ['ESNext', 'DOM'],
				types: ['node'],
				typeRoots: [
					resolve(import.meta.dirname, '../../host/node_modules/@types'),
					resolve(import.meta.dirname, '../node_modules/@types'),
				],
			},
		}),
	)
	const script = join(directory, 'task.ts')
	async function compile() {
		controller.signal.throwIfAborted()
		const pending = compileScript({ file: script, signal: controller.signal })
		pendingCompilations.add(pending)
		try {
			return await pending
		} finally {
			pendingCompilations.delete(pending)
		}
	}
	await writeFile(
		script,
		`import type {Script} from '@pluxel/agent-sdk/host';\nimport {Result} from '@pluxel/core/better-result';\nimport {${first.definitions[0].exportName} as Counter} from '${first.definitions[0].module}';\nexport default (async (sdk) => { const select=sdk.plugin; const counter=select(Counter.nodeAddress()); const {get,patch}=counter.config; const before=await get(); if(before.isErr())return before; const result=await patch({set:{step:2}},{expectedManagedRevision:before.value.managedRevision}); if(result.isErr())return result; const instance=await counter.instance(); if(instance.isErr())return instance; return Result.ok({result:result.value,count:instance.value.add(2)}) }) satisfies Script;\n`,
	)
	const artifact = await compile()
	expect(artifact.code).toContain('synced-counter')
	expect(artifact.code).not.toContain('class CounterInstance')
	await writeFile(
		script,
		`import type {Script} from '@pluxel/agent-sdk/host';\nimport {${first.definitions[0].exportName} as Counter} from '${first.definitions[0].module}';\nexport default (async(sdk) => {const {patch}=sdk.plugin(Counter.nodeAddress()).config;return patch({set:{step:'wrong'}})}) satisfies Script;\n`,
	)
	await expect(compile()).rejects.toMatchObject({ code: 'typecheck_failed' })
})

it('rejects corrupted or mixed chunks before publishing and preserves author files and edited snapshots', async () => {
	const { directory, reader } = await fixture()
	using source = reader
	const out = join(directory, 'control')
	const corrupt = {
		manifest: () => source.manifest(),
		file: async (input: Parameters<typeof source.file>[0]) => ({
			...source.file(input),
			data: Buffer.from('corrupt').toString('base64'),
		}),
	}
	await expect(writePluginControl({ source: corrupt, out })).rejects.toMatchObject({
		code: 'protocol_mismatch',
	})
	await expect(readFile(join(out, 'current/index.mjs'))).rejects.toMatchObject({ code: 'ENOENT' })
	await mkdir(out)
	await writeFile(join(out, 'author.ts'), 'author content')
	await expect(writePluginControl({ source, out })).rejects.toMatchObject({
		code: 'control_sync_conflict',
	})
	expect(await readFile(join(out, 'author.ts'), 'utf8')).toBe('author content')
	const owned = join(directory, 'owned')
	const installed = await writePluginControl({ source, out: owned })
	await writeFile(installed.definitions[0].module, '// author edited immutable file')
	await expect(writePluginControl({ source, out: owned })).rejects.toMatchObject({
		code: 'control_sync_conflict',
	})
	expect(await readFile(installed.definitions[0].module, 'utf8')).toBe(
		'// author edited immutable file',
	)
})

it('synchronizes through the public client using the original owner and authenticated local control methods', async () => {
	const { snapshot, reader } = await fixture()
	using _source = reader
	const dev = await createDevFixture({ materials: async () => snapshot })
	try {
		const result = await syncPluginControl({
			target: { root: dev.root },
			out: join(dev.root, '.pluxel/control'),
		})
		expect(result).toMatchObject({
			out: join(dev.root, '.pluxel/control'),
			catalogRevision: 3,
			definitions: [{ exportName: 'Counter', module: expect.any(String) }],
		})
		expect(await readFile(result.definitions[0].module, 'utf8')).toContain('synced-counter')
		expect(dev.requests.map((request) => request.method)).toContain('materials')
		expect(dev.requests.map((request) => request.method)).toContain('materialFile')
		expect(dev.requests.map((request) => request.method)).not.toContain('submit')
		expect(dev.requests.map((request) => request.method)).not.toContain('control')
	} finally {
		await dev.close()
	}
})

it('synchronizes through the SDK terminal adapter using the selected Vite root default and explicit output', async () => {
	const { snapshot, reader } = await fixture()
	using _source = reader
	const dev = await createDevFixture({ materials: async () => snapshot })
	const output: string[] = []
	vi.spyOn(console, 'log').mockImplementation((text) => output.push(String(text)))
	const command = define({ name: 'dev', args: devCommonArgs, subCommands: devSubCommands })
	try {
		for (const explicit of [false, true]) {
			const out = join(dev.root, explicit ? 'explicit-control' : '.pluxel/control')
			await cli(
				normalizeDevArgs(['dev', 'sync', '--root', dev.root, ...(explicit ? ['--out', out] : [])]),
				{ run() {} },
				{ subCommands: { dev: command } },
			)
			expect(output).toHaveLength(1)
			const value = JSON.parse(output.pop()!)
			expect(value).toMatchObject({
				ok: true,
				value: {
					out,
					catalogRevision: 3,
					definitions: [{ exportName: 'Counter', module: expect.any(String) }],
				},
			})
			expect(await readFile(value.value.definitions[0].module, 'utf8')).toContain('synced-counter')
		}
		expect(dev.requests.some((request) => ['submit', 'control'].includes(request.method))).toBe(
			false,
		)
	} finally {
		await dev.close()
	}
})
