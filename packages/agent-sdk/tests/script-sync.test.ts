import { mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { cli, define } from 'gunshi'
import {
	devCommonArgs,
	devSubCommands,
	normalizeDevArgs,
	scriptCommand,
} from '@pluxel/agent-sdk/internal/cli'
import { formatPluginDefinitionReference } from '@pluxel/core'
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
import {
	syncPluginControl as writePluginControl,
	type ControlMaterialSource,
} from '../src/client/materials'
import { syncPluginControl } from '@pluxel/agent-sdk/client'
import { createDevFixture } from './helpers/dev-fixture'

const remote = vi.hoisted(() => ({ connect: vi.fn() }))
vi.mock('../src/client/remote', () => ({ connectRuntimeTarget: remote.connect }))
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
		service?: boolean
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
	const service = {
		definition,
		exportName,
		module: 'index.mjs',
		contract: contracts.instance,
		access: 'all' as const,
		source: 'index.d.mts',
	}
	const files: Record<string, string> = {
		'index.mjs': renderPluginDescriptors(
			options.service ? [] : [{ exportName, descriptor: { format: 2, definition, contracts } }],
			options.service
				? [
						{
							exportName,
							descriptor: {
								format: 1,
								definition,
								contract: service.contract,
								access: service.access,
							},
						},
					]
				: [],
		),
		'index.d.mts': options.service
			? `import type { ServiceDefinition } from '@pluxel/core';\nexport interface ${exportName}Instance { count: number; add(delta: number): number }\nexport declare const ${exportName}: ServiceDefinition<${exportName}Instance, 'all'>;\n`
			: `import type { PluginDescriptor } from '@pluxel/host/internal/agent-types';\ndeclare class ${exportName}Instance { count: number; add(delta: number): number }\nexport type { ${exportName}Instance };\nexport type ${exportName}ConfigDeclaration = readonly [{ readonly expression: 'schema' }];\nexport type ${exportName}ConfigInput = { step?: number };\nexport type ${exportName}ConfigOutput = { step: number };\nexport declare const ${exportName}: PluginDescriptor<${exportName}ConfigInput, ${exportName}ConfigOutput, ${exportName}Instance>;\n`,
	}
	const entries = await Promise.all(
		Object.entries(files).map(async ([path, content]) => ({
			path,
			size: Buffer.byteLength(content),
			sha256: await controlSha256(content),
		})),
	)
	const unsigned = {
		format: 3 as const,
		compiler: 'script-sync-test',
		definitions: options.service
			? []
			: [{ definition, exportName, module: 'index.mjs', contracts, source: 'index.d.mts' }],
		services: options.service ? [service] : [],
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
		definitions: options.service ? [] : [{ definition, snapshot: manifest.snapshot, exportName }],
		services: options.service ? [{ definition, snapshot: manifest.snapshot, exportName }] : [],
		unavailableServices: [],
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
		services: [],
		unavailableServices: [],
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

it('selects definitions across index pages and downloads only their complete verified snapshots', async () => {
	const packageName = '@test/selected'
	const chosen = await Promise.all([
		fixture({ packageName }),
		fixture({ entry: { kind: 'package-subpath', packageName, subpath: './nested' } }),
	])
	const unrelated = await Promise.all(
		Array.from({ length: 17 }, (_, index) => fixture({ packageName: `@test/unselected-${index}` })),
	)
	const fixtures = [...unrelated, ...chosen]
	for (const item of fixtures) item.reader[Symbol.dispose]()
	using source = createPluginControlMaterialReader(async () => ({
		catalogRevision: 11,
		materials: fixtures.flatMap((item) => item.snapshot.materials),
		definitions: fixtures.flatMap((item) => item.snapshot.definitions),
		services: [],
		unavailableServices: [],
		unavailable: [],
	}))
	const manifest = vi.fn((input?: Parameters<ControlMaterialSource['manifest']>[0]) =>
		source.manifest(input),
	)
	const file = vi.fn((input: Parameters<ControlMaterialSource['file']>[0]) => source.file(input))
	const observed = { manifest, file }
	const out = join(chosen[0].directory, 'selected')
	const selected = await writePluginControl({ source: observed, out, packageName })
	expect(selected.definitions.map((entry) => entry.definition)).toEqual(
		expect.arrayContaining(chosen.map((item) => item.snapshot.definitions[0].definition)),
	)
	expect(selected.definitions).toHaveLength(2)
	expect(manifest).toHaveBeenCalledTimes(2)
	expect(file).toHaveBeenCalledTimes(6)
	expect(new Set(file.mock.calls.map(([input]) => input.snapshot))).toEqual(
		new Set(chosen.map((item) => item.snapshot.materials[0].snapshot)),
	)
	const current = await readlink(join(out, 'current'))
	const before = await readFile(selected.definitions[0].module, 'utf8')
	file.mockClear()
	await expect(
		writePluginControl({ source: observed, out, packageName: '@test/not-committed' }),
	).rejects.toMatchObject({ code: 'control_definition_not_found' })
	expect(file).not.toHaveBeenCalled()
	expect(await readlink(join(out, 'current'))).toBe(current)
	expect(await readFile(selected.definitions[0].module, 'utf8')).toBe(before)

	manifest.mockClear()
	const definition = chosen[1].snapshot.definitions[0].definition
	const exact = await writePluginControl({ source: observed, out, definition })
	expect(exact.definitions).toHaveLength(1)
	expect(exact.definitions[0].definition).toEqual(definition)
	expect(manifest).toHaveBeenCalledTimes(2)
	expect(file).toHaveBeenCalledTimes(3)
	expect(new Set(file.mock.calls.map(([input]) => input.snapshot))).toEqual(
		new Set([chosen[1].snapshot.materials[0].snapshot]),
	)
})

it('synchronizes required service descriptors and their instance types across mixed index pages', async () => {
	const plugin = await fixture({ packageName: '@test/mixed' })
	const service = await fixture({
		packageName: '@test/mixed',
		canonicalExportName: 'Clock',
		service: true,
	})
	const unrelated = await Promise.all(
		Array.from({ length: 16 }, (_, index) =>
			fixture({ packageName: `@test/before-service-${index}` }),
		),
	)
	const fixtures = [plugin, service, ...unrelated]
	for (const item of fixtures) item.reader[Symbol.dispose]()
	using source = createPluginControlMaterialReader(async () => ({
		catalogRevision: 20,
		materials: fixtures.flatMap((item) => item.snapshot.materials),
		definitions: fixtures.flatMap((item) => item.snapshot.definitions),
		services: fixtures.flatMap((item) => item.snapshot.services),
		unavailable: [],
		unavailableServices: [],
	}))
	const manifest = vi.fn((input?: Parameters<ControlMaterialSource['manifest']>[0]) =>
		source.manifest(input),
	)
	const file = vi.fn((input: Parameters<ControlMaterialSource['file']>[0]) => source.file(input))
	const out = join(service.directory, 'mixed')
	const result = await writePluginControl({
		source: { manifest, file },
		out,
		packageName: '@test/mixed',
	})
	expect(manifest).toHaveBeenCalledTimes(2)
	expect(result.definitions).toHaveLength(1)
	expect(result.services).toHaveLength(1)
	const clock = result.services[0]
	expect(clock.definition).toEqual(service.snapshot.services[0].definition)
	expect(clock.module).toBe(result.definitions[0].module)
	expect(clock.importStatement).toContain('import { Clock }')
	expect(await readFile(clock.module, 'utf8')).toContain('createServiceControlReference')
	expect(await readFile(clock.module.replace(/\.mjs$/, '.d.mts'), 'utf8')).toContain(
		'ClockInstance as ClockInstance',
	)
	expect(new Set(file.mock.calls.map(([input]) => input.snapshot))).toEqual(
		new Set([plugin.snapshot.materials[0].snapshot, service.snapshot.materials[0].snapshot]),
	)
	const exact = await writePluginControl({ source, out, definition: clock.definition })
	expect(exact.definitions).toEqual([])
	expect(exact.services).toEqual([clock])
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
		services: [],
		unavailableServices: [],
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
		services: [],
		unavailableServices: [],
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

it.each(process.platform === 'win32' ? ['?query'] : ['?query', 'back\\slash'])(
	'rejects unimportable output path %s before reading material or changing current',
	async (segment) => {
		const { directory, reader } = await fixture()
		using source = reader
		const installed = await writePluginControl({ source, out: join(directory, 'owned') })
		const current = await readlink(join(installed.out, 'current'))
		const before = await readFile(installed.definitions[0].module, 'utf8')
		const out = join(directory, segment)
		if (process.platform !== 'win32') await symlink(installed.out, out, 'dir')
		const manifest = vi.fn((input?: Parameters<ControlMaterialSource['manifest']>[0]) =>
			source.manifest(input),
		)
		const file = vi.fn((input: Parameters<ControlMaterialSource['file']>[0]) => source.file(input))
		await expect(writePluginControl({ source: { manifest, file }, out })).rejects.toMatchObject({
			code: 'invalid_input',
			message: expect.stringContaining('TypeScript/Rolldown cannot import'),
		})
		expect(manifest).not.toHaveBeenCalled()
		expect(file).not.toHaveBeenCalled()
		expect(await readlink(join(installed.out, 'current'))).toBe(current)
		expect(await readFile(installed.definitions[0].module, 'utf8')).toBe(before)
	},
)

it('publishes verified entry modules atomically and compiles imports through their stable current paths', async () => {
	const controller = new AbortController()
	compilationController = controller
	const { directory, reader } = await fixture()
	using source = reader
	const out = join(directory, 'control with \'single\' "double" #')
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
		`import type {Script} from '@pluxel/agent-sdk/host';\n${first.definitions[0].importStatement}\nexport default (async (sdk) => { const select=sdk.plugin; const counter=select(Counter.nodeAddress()); const {get,patch}=counter.config; const before=await get(); const result=await patch({set:{step:2}},{expectedManagedRevision:before.managedRevision}); const {instance}=await counter.instance(); return {result,count:instance.add(2)} }) satisfies Script;\n`,
	)
	const artifact = await compile()
	expect(artifact.code).toContain('synced-counter')
	expect(artifact.code).not.toContain('class CounterInstance')
	await writeFile(
		script,
		`import type {Script} from '@pluxel/agent-sdk/host';\n${first.definitions[0].importStatement}\nexport default (async(sdk) => {const {patch}=sdk.plugin(Counter.nodeAddress()).config;return patch({set:{step:'wrong'}})}) satisfies Script;\n`,
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
	const current = await readlink(join(owned, 'current'))
	const before = await readFile(installed.definitions[0].module, 'utf8')
	await expect(writePluginControl({ source: corrupt, out: owned })).rejects.toMatchObject({
		code: 'protocol_mismatch',
	})
	expect(await readlink(join(owned, 'current'))).toBe(current)
	expect(await readFile(installed.definitions[0].module, 'utf8')).toBe(before)
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

it('uses the same package and exact definition selectors in development and deployment commands', async () => {
	const wanted = await fixture()
	const unrelated = await fixture({ packageName: '@test/other-counter' })
	wanted.reader[Symbol.dispose]()
	unrelated.reader[Symbol.dispose]()
	const snapshot: PluginControlMaterialsSnapshot = {
		catalogRevision: 12,
		materials: [...unrelated.snapshot.materials, ...wanted.snapshot.materials],
		definitions: [...unrelated.snapshot.definitions, ...wanted.snapshot.definitions],
		services: [],
		unavailableServices: [],
		unavailable: [],
	}
	const dev = await createDevFixture({ materials: async () => snapshot })
	using source = createPluginControlMaterialReader(async () => snapshot)
	remote.connect.mockReset().mockResolvedValue({
		description: { protocol: { capabilities: ['plugins.control-materials'] } },
		management: { materials: source },
		[Symbol.dispose]() {},
	})
	const output: string[] = []
	vi.spyOn(console, 'log').mockImplementation((text) => output.push(String(text)))
	const command = define({ name: 'dev', args: devCommonArgs, subCommands: devSubCommands })
	try {
		for (const family of ['dev', 'script']) {
			for (const selector of ['package-name', 'definition']) {
				const value =
					selector === 'package-name'
						? '@test/synced-counter'
						: formatPluginDefinitionReference(wanted.snapshot.definitions[0].definition)
				await cli(
					normalizeDevArgs([
						family,
						'sync',
						...(family === 'dev' ? ['--root', dev.root] : ['--endpoint', 'https://host.test/']),
						'--out',
						join(dev.root, `${family}-${selector}`),
						`--${selector}`,
						value,
					]),
					{ run() {} },
					{ subCommands: { dev: command, script: scriptCommand } },
				)
				expect(output).toHaveLength(1)
				const result = JSON.parse(output.pop()!)
				expect(result).toMatchObject({ ok: true, value: { catalogRevision: 12 } })
				expect(result.value.definitions).toHaveLength(1)
				expect(result.value.definitions[0].definition).toEqual(
					wanted.snapshot.definitions[0].definition,
				)
			}
		}
	} finally {
		await dev.close()
	}
})

it('rejects invalid and conflicting command selectors before discovering or opening a target', async () => {
	remote.connect.mockReset()
	const output: string[] = []
	vi.spyOn(console, 'log').mockImplementation((text) => output.push(String(text)))
	const command = define({ name: 'dev', args: devCommonArgs, subCommands: devSubCommands })
	for (const family of ['dev', 'script']) {
		for (const selection of [
			['--definition', 'not-a-definition-reference'],
			['--package-name', '@test/package/extra'],
			['--package-name', '@test/package', '--definition', 'package:@test/package::Counter'],
		]) {
			await cli(
				normalizeDevArgs([
					family,
					'sync',
					...(family === 'dev'
						? ['--root', join(tmpdir(), 'missing-pluxel-project')]
						: ['--endpoint', 'https://host.test/']),
					...selection,
				]),
				{ run() {} },
				{ subCommands: { dev: command, script: scriptCommand } },
			)
			expect(output).toHaveLength(1)
			expect(JSON.parse(output.pop()!)).toMatchObject({
				ok: false,
				error: { code: 'invalid_input' },
			})
		}
	}
	expect(remote.connect).not.toHaveBeenCalled()
})
