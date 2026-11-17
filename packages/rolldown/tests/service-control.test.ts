import { rolldown } from 'rolldown'
import { createPluginSemanticsPlugin } from '../src/rolldown/plugins/pluginSemanticsPlugin'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { createHost, defineHostService } from '@pluxel/host'
import { pluginDefinitionIndexKey } from '@pluxel/core'
import { createNodeScriptOwner } from '@pluxel/host/internal/agent/node'
import { installRootService } from '@pluxel/core/host'
import { __defineServiceDefinition } from '@pluxel/core/toolchain'
import { readServiceDefinition } from '@pluxel/core/internal'
import { setServiceControlMaterial } from '@pluxel/host/internal'
import { lowerServiceModule, serviceSourceEntry } from '../src/service-semantics'
import { generatePluginControl } from '../src/control/generate-plugin'
import { compileScript } from '../src/scripts'
import * as serviceControlContracts from '../src/control/manifest'

const directories: string[] = []
afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	)
})
async function fixture() {
	const directory = await mkdtemp(resolve(tmpdir(), 'pluxel-service-control-'))
	directories.push(directory)
	for (const name of ['@pluxel/core', '@pluxel/host', '@pluxel/agent-sdk', '@types/node']) {
		const path = resolve(directory, 'node_modules', name)
		await mkdir(dirname(path), { recursive: true })
		await symlink(resolve(import.meta.dirname, '../node_modules', name), path, 'dir')
	}
	await writeFile(
		resolve(directory, 'tsconfig.json'),
		JSON.stringify({
			extends: resolve(import.meta.dirname, '../tsconfig.json'),
			include: ['*.ts'],
			compilerOptions: { strictNullChecks: true },
		}),
	)
	return directory
}
async function lower(directory: string, name: string, code: string) {
	const id = resolve(directory, name)
	await writeFile(id, code)
	return lowerServiceModule({
		id,
		code,
		resolve: async (source) => (source.startsWith('.') ? resolve(directory, source) : undefined),
		canonicalSourceEntry: (sourceId) => serviceSourceEntry(directory, sourceId),
		controlContracts: serviceControlContracts,
		error: (message) => {
			throw new Error(message)
		},
	})
}

it('preserves a compiled native service installation only through the exact toolchain binder import', async () => {
	const directory = await fixture()
	const code = (source: string) => `
import { installRootService as install } from '@pluxel/core/host'
import { __defineServiceDefinition as bind } from ${JSON.stringify(source)}
const Clock = class {}
export const plan = install(bind(Clock, { format: 1, definition: {
 entry: { kind: 'package-root', packageName: '@example/clock' }, exportName: 'Clock'
} }), { create: () => new Clock() })
`
	expect(await lower(directory, 'compiled.mjs', code('@pluxel/core/toolchain'))).toEqual({
		replacements: [],
		services: [],
		hasDefinitions: false,
		hasRefs: false,
	})
	await expect(lower(directory, 'lookalike.mjs', code('@example/toolchain'))).rejects.toThrow(
		'installation requires a direct service declaration',
	)
})

it.each([undefined, 'all', 'owner', 'root'] as const)(
	'proves an optional native declaration with %s access without an installer-side contract',
	async (access) => {
		const directory = await fixture()
		const root = resolve(directory, 'node_modules/@example/native-declaration')
		await mkdir(root, { recursive: true })
		await writeFile(
			resolve(root, 'package.json'),
			JSON.stringify({
				name: '@example/native-declaration',
				type: 'module',
				exports: {
					'.': { types: './index.d.mts', default: './index.mjs' },
					'./alias': { types: './alias.d.mts', default: './alias.mjs' },
				},
			}),
		)
		await writeFile(resolve(root, 'index.d.mts'), "export { n as Clock } from './native.mjs'\n")
		await writeFile(
			resolve(root, 'alias.d.mts'),
			"export { n as PublishedClock } from './native.mjs'\n",
		)
		await writeFile(
			resolve(root, 'native.d.mts'),
			`declare abstract class NativeClock {
 ${access ? `static readonly access: ${JSON.stringify(access)}` : ''}
 abstract now(): number
}
export { NativeClock as n }
`,
		)
		const result = await lower(
			directory,
			'optional.ts',
			`import { defineServiceRef } from '@pluxel/core'
import type { PublishedClock } from '@example/native-declaration/alias'
const Clock = defineServiceRef<PublishedClock>()
`,
		)
		expect(result.services).toEqual([])
		expect(result.replacements.map((replacement) => replacement.text)).toEqual([
			`__pluxelDefineServiceRef(${JSON.stringify({
				format: 1,
				definition: {
					entry: { kind: 'package-root', packageName: '@example/native-declaration' },
					exportName: 'Clock',
				},
				access: access ?? 'all',
			})})`,
		])
	},
)

it('proves the same service identity for an ordinary class installation and its optional imported reference', async () => {
	const directory = await fixture()
	await writeFile(
		resolve(directory, 'search.ts'),
		"export class Search { static readonly access = 'root' as const; query(term:string):string { return term } }\n",
	)
	const result = await lower(
		directory,
		'entry.ts',
		`import { installRootService as install } from '@pluxel/core/host'
import { defineServiceRef } from '@pluxel/core'
import { Search } from './search.ts'
const optional = defineServiceRef<Search>()
export const plan = install(Search, { create: () => new Search() })
`,
	)
	expect(result.services).toHaveLength(1)
	expect(result.services[0]).toMatchObject({
		className: 'Search',
		access: 'root',
		definition: {
			entry: { kind: 'source-entry', sourceSpace: 'app', path: 'search.ts' },
			exportName: 'Search',
		},
	})
	expect(result.replacements.map((item) => item.text).join('\n')).toContain('"access":"root"')
	expect(
		result.replacements.every((item) =>
			item.text.includes(JSON.stringify(result.services[0]!.definition)),
		),
	).toBe(true)
	const descriptor = await lower(
		directory,
		'descriptor.ts',
		`import { installRootService } from '@pluxel/core/host'
import { createServiceReference } from '@pluxel/core/internal'
const required = createServiceReference<{query():string},{ } extends never ? never : 'all'>({definition: {} as never, access:'all'})
export const installation = installRootService(required, { create: () => ({query:()=> 'ok'}) })`,
	)
	expect(descriptor.services).toEqual([])
	expect(descriptor.replacements).toEqual([])
	await expect(
		lower(
			directory,
			'invalid.ts',
			`import { defineServiceRef } from '@pluxel/core'; import type { Search } from './search.ts'; export const Ref = defineServiceRef<Search>()`,
		),
	).rejects.toThrow('unexported module-level const')
})

it('generates service contracts and executes required and optional upload references on the receiving Host', async () => {
	const directory = await fixture(),
		moduleId = resolve(directory, 'search.ts')
	await writeFile(
		moduleId,
		"throw new Error('generation must never evaluate service code'); export class Search { query(term:string):string { return term } }\n",
	)
	const definition = {
		entry: { kind: 'source-entry' as const, sourceSpace: 'app', path: 'search.ts' },
		exportName: 'Search',
	}
	const generate = (access: 'all' | 'root') =>
		generatePluginControl({
			root: directory,
			definitions: [],
			services: [{ moduleId, className: 'Search', definition, access }],
		})
	const material = await generate('all')
	expect(material.manifest).toMatchObject({
		format: 3,
		definitions: [],
		services: [{ definition, access: 'all', contract: expect.stringMatching(/^sha256:/) }],
	})
	expect(material.files['index.mjs']).toContain('createServiceControlReference')
	expect(material.files['index.d.mts']).toContain('ServiceDefinition<SearchInstance, "all">')
	const rootMaterial = await generate('root')
	expect(rootMaterial.manifest.services[0]!.contract).not.toBe(
		material.manifest.services[0]!.contract,
	)
	const control = resolve(directory, 'control')
	for (const [name, source] of Object.entries(material.files)) {
		const path = resolve(control, name)
		await mkdir(dirname(path), { recursive: true })
		await writeFile(path, source)
	}
	await writeFile(
		resolve(directory, 'required.ts'),
		`import type { Script } from '@pluxel/agent-sdk/host'
import { Search } from './control/index.mjs'
export default (async sdk => sdk.ctx.service(Search).query('required')) satisfies Script`,
	)
	await writeFile(
		resolve(directory, 'optional.ts'),
		`import type { Script } from '@pluxel/agent-sdk/host'
import { defineServiceRef } from '@pluxel/core'
import type { SearchInstance } from './control/index.mjs'
const Search = defineServiceRef<SearchInstance>()
export default (async sdk => sdk.ctx.service(Search)?.query('optional') ?? 'missing') satisfies Script`,
	)
	const required = await compileScript({ file: resolve(directory, 'required.ts') }),
		optional = await compileScript({ file: resolve(directory, 'optional.ts') })
	expect(optional.code).not.toContain('@pluxel/core')
	expect(optional.code).toContain('createServiceControlRef')
	class NativeSearch {
		query(term: string) {
			return term
		}
	}
	__defineServiceDefinition(NativeSearch, { format: 1, definition })
	setServiceControlMaterial(NativeSearch, {
		snapshot: material.snapshot,
		manifest: material.manifest,
		files: material.files,
	})
	const installation = defineHostService({
		name: 'search',
		provides: [installRootService(NativeSearch, { create: () => new NativeSearch() })],
	})
	await using host = await createHost({
		plugins: [],
		services: [installation],
		runtime: { documents: { config: false, state: false } },
	})
	await host.start()
	await using owner = createNodeScriptOwner({ ctx: host.ctx })
	for (const [artifact, value] of [
		[required, 'required'],
		[optional, 'optional'],
	] as const) {
		await owner.executor.submit({ runId: value, code: artifact }, 'author')
		const result = await owner.executor.settled(value, 'author')
		expect(result).toMatchObject({ state: 'succeeded', value })
	}
	expect(readServiceDefinition(NativeSearch).optional).toBe(false)
	await using empty = await createHost({
		plugins: [],
		runtime: { documents: { config: false, state: false } },
	})
	await empty.start()
	await using emptyOwner = createNodeScriptOwner({ ctx: empty.ctx })
	await emptyOwner.executor.submit({ runId: 'optional', code: optional }, 'author')
	expect(await emptyOwner.executor.settled('optional', 'author')).toMatchObject({
		state: 'succeeded',
		value: 'missing',
	})
	await emptyOwner.executor.submit({ runId: 'required', code: required }, 'author')
	expect(await emptyOwner.executor.settled('required', 'author')).toMatchObject({
		state: 'failed',
		error: { code: 'CONTEXT_SERVICE_MISSING' },
	})
}, 60_000)

it('resolves externalized service imports from their actual public source export', async () => {
	const directory = await fixture(),
		owner = resolve(directory, 'node_modules/public-service')
	await mkdir(owner)
	await writeFile(
		resolve(owner, 'package.json'),
		JSON.stringify({
			name: 'public-service',
			exports: { '.': { '@pluxel/source': './source.ts', default: './built.mjs' } },
		}),
	)
	await writeFile(
		resolve(owner, 'source.ts'),
		"export class PublicService { static readonly access = 'root' as const }\n",
	)
	const code = `import { defineServiceRef } from '@pluxel/core'
import type { PublicService } from 'public-service'
const optional = defineServiceRef<PublicService>()`
	const result = await lowerServiceModule({
		code,
		id: resolve(directory, 'entry.ts'),
		resolve: async (source) => source,
		canonicalSourceEntry: (id) => serviceSourceEntry(directory, id),
		error: (message) => {
			throw new Error(message)
		},
	})
	expect(result.replacements[0]!.text).toContain(
		'"kind":"package-root","packageName":"public-service"',
	)
	expect(result.replacements[0]!.text).toContain('"access":"root"')
})

it('lowers service references and installations outside the selected Plugin compilation files', async () => {
	const directory = await fixture()
	await writeFile(
		resolve(directory, 'service.ts'),
		'export class Search { query():string { return "ok" } }',
	)
	const entry = resolve(directory, 'entry.ts')
	await writeFile(
		entry,
		`import { installRootService } from '@pluxel/core/host'
import { defineServiceRef } from '@pluxel/core'
import { Search } from './service.ts'
const optional = defineServiceRef<Search>()
export {optional as optionalValue}
export const plan = installRootService(Search, {create: () => new Search()})`.replace(
			'export {optional as optionalValue}',
			'export function borrow(ctx:{ service(ref:typeof optional):unknown }) { return ctx.service(optional) }',
		),
	)
	const semantics = createPluginSemanticsPlugin({
		root: directory,
		include: ['**/plugins-only/**'],
	})
	const build = await rolldown({
		input: entry,
		plugins: [semantics.plugin],
		external: [/^@pluxel\//],
	})
	try {
		const output = await build.generate({ format: 'esm' })
		const code = output.output
			.filter((item) => item.type === 'chunk')
			.map((item) => item.code)
			.join('\n')
		expect(code).toContain('__defineServiceDefinition')
		expect(code).toContain('__defineServiceRef')
		expect(code).not.toContain('defineServiceRef()')
		expect(semantics.serviceDefinitions()).toHaveLength(1)
	} finally {
		await build.close()
	}
})

it('follows named declaration exports without admitting unused optional drivers from their barrels', async () => {
	const directory = await fixture()
	const library = resolve(directory, 'node_modules/typed-database')
	await mkdir(library)
	for (const [name, code] of Object.entries({
		'package.json': JSON.stringify({ name: 'typed-database', types: 'index.d.ts' }),
		'index.d.ts':
			'export { PgDatabase } from "./pg.js"; export { OtherDatabase } from "./other.js"',
		'pg.d.ts':
			'import type { Column } from "./columns.js"; export interface PgDatabase { column: Column }',
		'columns.d.ts':
			'export { Column } from "./column.js"; export { OtherDatabase } from "./other.js"',
		'column.d.ts': 'export interface Column { name: string }',
		'other.d.ts':
			'import type { Driver } from "uninstalled-driver"; export interface OtherDatabase { driver: Driver }',
	}))
		await writeFile(resolve(library, name), code)
	const moduleId = resolve(directory, 'sql.ts')
	await writeFile(
		moduleId,
		'import type { PgDatabase } from "typed-database"; export abstract class Sql { abstract use(): PgDatabase }',
	)
	const definition = {
		entry: { kind: 'source-entry' as const, sourceSpace: 'app', path: 'sql.ts' },
		exportName: 'Sql',
	}
	const generate = () =>
		generatePluginControl({
			root: directory,
			definitions: [],
			services: [{ moduleId, className: 'Sql', definition, access: 'all' }],
		})
	const material = await generate()
	const inputs = material.definitionInputs[pluginDefinitionIndexKey(definition)]!
	expect(inputs).toContain(resolve(library, 'index.d.ts'))
	expect(inputs).toContain(resolve(library, 'columns.d.ts'))
	expect(inputs).toContain(resolve(library, 'column.d.ts'))
	expect(inputs).not.toContain(resolve(library, 'other.d.ts'))
	await writeFile(
		moduleId,
		'import type { OtherDatabase } from "typed-database"; export abstract class Sql { abstract use(): OtherDatabase }',
	)
	await expect(generate()).rejects.toThrow(
		'Cannot resolve emitted declaration import "uninstalled-driver"',
	)
}, 30_000)

it('binds private package installations without publishing them as service control declarations', async () => {
	const directory = await fixture()
	await writeFile(
		resolve(directory, 'package.json'),
		JSON.stringify({
			name: 'public-service',
			exports: { '.': { '@pluxel/source': './public.ts', default: './built.mjs' } },
		}),
	)
	await writeFile(resolve(directory, 'public.ts'), 'export class Public {}')
	await writeFile(resolve(directory, 'private.ts'), 'export class Private {}')
	const entry = resolve(directory, 'entry.ts')
	await writeFile(
		entry,
		`import { installRootService } from '@pluxel/core/host'
import { Private } from './private.ts'
export const plan = installRootService(Private, {create: () => new Private()})`,
	)
	const semantics = createPluginSemanticsPlugin({ root: directory })
	const build = await rolldown({
		input: entry,
		plugins: [semantics.plugin],
		external: [/^@pluxel\//],
	})
	try {
		const output = await build.generate({ format: 'esm' })
		expect(
			output.output
				.filter((item) => item.type === 'chunk')
				.map((item) => item.code)
				.join('\n'),
		).toContain('__defineServiceDefinition')
		expect(semantics.serviceDefinitions()).toEqual([])
	} finally {
		await build.close()
	}
})

it('proves published service aliases from verified sidecars and native declarations without source or implementation evaluation', async () => {
	const directory = await fixture(),
		owner = resolve(directory, 'node_modules/published-service')
	await mkdir(owner)
	const moduleId = resolve(owner, 'source.ts')
	await writeFile(
		moduleId,
		'export class PublicService { static readonly access = "root" as const; value():string { return "ok" } }',
	)
	const definition = {
		entry: { kind: 'package-root' as const, packageName: 'published-service' },
		exportName: 'PublicService',
	}
	const material = await generatePluginControl({
		root: directory,
		definitions: [],
		services: [{ moduleId, className: 'PublicService', definition, access: 'root' }],
	})
	for (const [name, content] of Object.entries(material.files)) {
		const path = resolve(owner, 'control', name)
		await mkdir(dirname(path), { recursive: true })
		await writeFile(path, content)
	}
	await writeFile(
		resolve(owner, 'package.json'),
		JSON.stringify({
			name: 'published-service',
			exports: {
				'.': { types: './index.d.mts', default: './index.mjs' },
				'./alias': { types: './alias.d.mts', default: './alias.mjs' },
			},
			pluxel: { control: './control/manifest.json' },
		}),
	)
	await writeFile(
		resolve(owner, 'index.mjs'),
		'throw new Error("implementation must not load"); class a {}; export {a as PublicService}',
	)
	await writeFile(
		resolve(owner, 'index.d.mts'),
		'declare class Native { static readonly access: "root"; value():string }; export { Native as PublicService }',
	)
	await writeFile(
		resolve(owner, 'alias.d.mts'),
		'export { PublicService as Alias } from "./index.mjs"',
	)
	await rm(moduleId)
	const result = await lower(
		directory,
		'published.ts',
		`import {defineServiceRef} from '@pluxel/core'; import type {Alias} from 'published-service/alias'; const ref=defineServiceRef<Alias>()`,
	)
	expect(result.replacements[0]!.text).toContain(
		JSON.stringify({ format: 1, definition, access: 'root' }),
	)
	expect(result.replacements[0]!.text).not.toContain(material.manifest.services[0]!.contract)
	await writeFile(resolve(owner, 'control/index.mjs'), 'invalid')
	await expect(
		lower(
			directory,
			'corrupt.ts',
			`import {defineServiceRef} from '@pluxel/core'; import type {Alias} from 'published-service/alias'; const ref=defineServiceRef<Alias>()`,
		),
	).rejects.toThrow('size mismatch')
}, 30_000)
