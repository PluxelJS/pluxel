import { mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { cli as gunshiCli } from 'gunshi'
import {
	controlSha256,
	createPluginControlMaterialReader,
	encodeControlData,
	renderPluginDescriptors,
	verifyPluginControlMaterial,
	type PluginControlMaterialsSnapshot,
} from '@pluxel/host/agent'
import { compileScript } from '@pluxel/rolldown/scripts'
import { syncPluginControl } from '../src/script/sync'
import { createDevFixture } from './helpers/dev-fixture'
import { devCommand } from '../src/commands/dev'
import { normalizeDevArgs } from '../src/command-manifest'

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
	options: Readonly<{ materialExportName?: string; packageName?: string }> = {},
) {
	const directory = await mkdtemp(join(tmpdir(), 'pluxel-control-sync-'))
	directories.push(directory)
	await symlink(
		resolve(import.meta.dirname, '../node_modules'),
		join(directory, 'node_modules'),
		'dir',
	)
	await writeFile(
		join(directory, 'package.json'),
		JSON.stringify({ private: true, type: 'module' }),
	)
	const exportName = options.materialExportName ?? 'Counter'
	const definition = {
		entry: {
			kind: 'package-root' as const,
			packageName: options.packageName ?? '@test/synced-counter',
		},
		exportName: 'Counter',
	}
	const contracts = { config: `sha256:${'a'.repeat(64)}`, instance: `sha256:${'b'.repeat(64)}` }
	const files: Record<string, string> = {
		'index.mjs': renderPluginDescriptors([
			{ exportName, descriptor: { format: 1, definition, contracts } },
		]),
		'index.d.mts': `import type { PluginDescriptor } from '@pluxel/host/agent';\ndeclare class ${exportName}Instance { count: number; add(delta: number): number }\nexport type { ${exportName}Instance };\nexport type ${exportName}ConfigDeclaration = readonly [{ readonly expression: 'schema' }];\nexport type ${exportName}ConfigInput = { step?: number };\nexport type ${exportName}ConfigOutput = { step: number };\nexport declare const ${exportName}: PluginDescriptor<${exportName}ConfigInput, ${exportName}ConfigOutput, ${exportName}Instance>;\n`,
	}
	const entries = await Promise.all(
		Object.entries(files).map(async ([path, content]) => ({
			path,
			size: Buffer.byteLength(content),
			sha256: await controlSha256(content),
		})),
	)
	const unsigned = {
		format: 1 as const,
		compiler: 'script-sync-test',
		definitions: [{ definition, exportName, contracts, source: 'index.d.mts' }],
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
	const first = await syncPluginControl({ source: together, out })
	const selected = first.definitions.find(
		(entry) =>
			encodeControlData(entry.definition) ===
			encodeControlData(original.snapshot.definitions[0].definition),
	)!
	expect(first.definitions).toHaveLength(2)
	expect(new Set(first.definitions.map((entry) => entry.exportName)).size).toBe(2)
	expect(selected.exportName).toMatch(/^Counter_[a-f0-9]{16}$/)
	expect(await readFile(join(out, 'current/index.d.mts'), 'utf8')).toContain(
		`Plugin_previous_alias as ${selected.exportName}`,
	)

	const renamed = await fixture()
	using renamedReader = renamed.reader
	const next = await syncPluginControl({ source: renamedReader, out })
	expect(next.definitions).toHaveLength(1)
	expect(next.definitions[0]).toEqual(selected)
	expect(next.snapshot).not.toBe(first.snapshot)
	expect(await readFile(join(out, 'current/index.d.mts'), 'utf8')).toContain(
		`Counter as ${selected.exportName}`,
	)
})

it('publishes a verified aggregate atomically and compiles imports through its stable current entry', async () => {
	const controller = new AbortController()
	compilationController = controller
	const { directory, reader } = await fixture()
	using source = reader
	const out = join(directory, 'control')
	const first = await syncPluginControl({ source, out })
	expect(first.entry).toBe(join(out, 'current/index.mjs'))
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
	expect(files['index.d.mts']).toContain(
		`CounterConfigDeclaration as ${first.definitions[0].exportName}ConfigDeclaration`,
	)
	await expect(syncPluginControl({ source, out })).resolves.toMatchObject({
		snapshot: first.snapshot,
		entry: first.entry,
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
		`import type {Script} from '@pluxel/host/agent';\nimport {${first.definitions[0].exportName} as Counter} from './control/current/index.mjs';\nexport default ((sdk) => sdk.Result.gen(async function* () { const select=sdk.plugin; const counter=select(Counter); const {get,patch}=counter.config; const before=yield* sdk.Result.await(get()); const result=yield* sdk.Result.await(patch({set:{step:2}},{expectedManagedRevision:before.managedRevision})); const instance=yield* sdk.Result.await(counter.instance()); return sdk.Result.ok({result,count:instance.add(2)}) })) satisfies Script;\n`,
	)
	const artifact = await compile()
	expect(artifact.code).toContain('synced-counter')
	expect(artifact.code).not.toContain('class CounterInstance')
	await writeFile(
		script,
		`import type {Script} from '@pluxel/host/agent';\nimport {${first.definitions[0].exportName} as Counter} from './control/current/index.mjs';\nexport default (async(sdk) => {const {patch}=sdk.plugin(Counter).config;return patch({set:{step:'wrong'}})}) satisfies Script;\n`,
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
	await expect(syncPluginControl({ source: corrupt, out })).rejects.toMatchObject({
		code: 'protocol_mismatch',
	})
	await expect(readFile(join(out, 'current/index.mjs'))).rejects.toMatchObject({ code: 'ENOENT' })
	await mkdir(out)
	await writeFile(join(out, 'author.ts'), 'author content')
	await expect(syncPluginControl({ source, out })).rejects.toMatchObject({
		code: 'control_sync_conflict',
	})
	expect(await readFile(join(out, 'author.ts'), 'utf8')).toBe('author content')
	const owned = join(directory, 'owned')
	const installed = await syncPluginControl({ source, out: owned })
	await writeFile(installed.entry, '// author edited immutable file')
	await expect(syncPluginControl({ source, out: owned })).rejects.toMatchObject({
		code: 'control_sync_conflict',
	})
	expect(await readFile(installed.entry, 'utf8')).toBe('// author edited immutable file')
})

it('runs dev sync through the existing owner selection and authenticated local control methods', async () => {
	const { snapshot, reader } = await fixture()
	using _source = reader
	const dev = await createDevFixture({ materials: async () => snapshot })
	const output: string[] = []
	vi.spyOn(console, 'log').mockImplementation((value) => output.push(String(value)))
	try {
		await gunshiCli(
			normalizeDevArgs(['dev', 'sync', '--root', dev.root]),
			{ run() {} },
			{ subCommands: { dev: devCommand } },
		)
		expect(process.exitCode ?? 0).toBe(0)
		const result = JSON.parse(output.at(-1)!)
		expect(result).toMatchObject({
			ok: true,
			value: { entry: join(dev.root, '.pluxel/control/current/index.mjs'), catalogRevision: 3 },
		})
		expect(await readFile(result.value.entry, 'utf8')).toContain('synced-counter')
		expect(dev.requests.map((request) => request.method)).toContain('materials')
		expect(dev.requests.map((request) => request.method)).toContain('materialFile')
		expect(dev.requests.map((request) => request.method)).not.toContain('submit')
		expect(dev.requests.map((request) => request.method)).not.toContain('control')
	} finally {
		await dev.close()
	}
})
