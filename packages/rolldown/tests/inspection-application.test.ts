import { dirname, resolve } from 'node:path'
import { renderPluginDescriptors } from '@pluxel/core/internal/control-manifest'
import { describe, expect, it } from 'vitest'
import { inspectApplicationInputs } from '../src/inspect/application'

const prefix = `import { defineHostApplication, envBinding, fileBinding } from '@pluxel/host'
import { P, Q, Schema } from './plugins.ts'
throw new Error('entry must never execute')
`
const application = (body: string) =>
	`${prefix}\nexport default defineHostApplication(() => ({${body}}))`
const node = (fields: string) => application(`plugins:[{plugin:P,${fields}}]`)
const definition = {
	entry: { kind: 'package-root', packageName: '@fixture/plugins' },
	exportName: 'P',
} as const
const plugins = `throw new Error('schema must never execute'); export class P {} export class Q {} export const Schema = makeSchema(() => { throw new Error('callback must never execute') })`
function inspect(
	code: string,
	entry = '/project/a.ts',
	extra: Record<string, string> = {},
	overrides: Partial<Parameters<typeof inspectApplicationInputs>[0]> = {},
) {
	const files: Record<string, string> = { [entry]: code, '/project/plugins.ts': plugins, ...extra }
	const reads: string[] = []
	const result = inspectApplicationInputs({
		application: { root: '/project', entry, sourceSpaces: [{ name: 'app', root: '/project' }] },
		definition,
		async read(id) {
			reads.push(id)
			if (!(id in files)) throw new Error(`unexpected file read: ${id}`)
			return files[id]!
		},
		async resolve(source, importer) {
			return source.startsWith('.') ? resolve(dirname(importer), source) : undefined
		},
		async matchesPlugin(symbol) {
			return symbol.moduleId === '/project/plugins.ts' && symbol.local === 'P'
		},
		location(id, start, end) {
			const position = (offset: number) => {
				const before = files[id]!.slice(0, offset).split('\n')
				return { line: before.length, column: before.at(-1)!.length + 1 }
			}
			return { file: id, start: position(start), end: position(end) }
		},
		...overrides,
	})
	return { result, reads }
}

describe('application input declaration navigation', () => {
	it('navigates disjoint mappings and multiple unread config files for one owner', async () => {
		const report = await inspect(
			node(`
			envBindings: [
				envBinding({config: {schema: Schema, mapping: {nested: {one: 'FIRST'}}}}),
				envBinding({config: {schema: Schema, mapping: {nested: {two: 'SECOND'}}}}),
			],
			fileBindings: [
				fileBinding({config: {schema: Schema, path: './one.json'}}),
				fileBinding({config: {schema: Schema, path: './two.json'}}),
			],
		`),
		).result
		expect(report.status).toBe('complete')
		if (report.status === 'unavailable') throw new Error('unavailable')
		expect(report.value.bindings.map((binding) => binding.configPath)).toEqual([
			['nested', 'one'],
			['nested', 'two'],
			[],
			[],
		])
	})

	it('reports ancestor mapping overlaps without guessing file contents', async () => {
		const report = await inspect(
			node(`envBindings: [
			envBinding({config: {schema: Schema, mapping: {nested: {one: 'FIRST'}}}}),
			envBinding({config: {schema: Schema, mapping: {nested: 'SECOND'}}}),
		]`),
		).result
		expect(report.status).toBe('partial')
		if (report.status !== 'partial') throw new Error('not partial')
		expect(report.value.bindings).toHaveLength(1)
		expect(report.gaps).toMatchObject([{ code: 'invalid_declaration' }])
	})

	it('keeps default and literal fork binding targets distinct without executing nodeAddress', async () => {
		const report = await inspect(
			node(`
			envBindings: [
				envBinding({config: {schema: Schema, mapping: {endpoint: 'DEFAULT_ENDPOINT'}}}),
			],
			forks: {
				east: { envBindings: [
					envBinding({config: {schema: Schema, mapping: {endpoint: 'EAST_ENDPOINT'}}}),
				] },
			},
		`),
		).result
		expect(report.status).toBe('complete')
		if (report.status === 'unavailable') throw new Error('unavailable')
		expect(report.value.bindings).toMatchObject([
			{ source: { name: 'DEFAULT_ENDPOINT' } },
			{ forkId: 'east', source: { name: 'EAST_ENDPOINT' } },
		])
		expect(report.value.bindings[0]).not.toHaveProperty('forkId')
	})

	it('locates a predeclared fork using a generated control address without loading the implementation', async () => {
		const { result } = inspect(
			`${prefix}
			import { Dynamic } from './control.mjs'
			export default defineHostApplication(() => ({
				sources: directories.map(directory => ({directory, include:['*.mjs']})),
				pluginNodes: [{
					definition: Dynamic.address(),
					config: { endpoint: 'https://example.test' },
					forks: {
						east: { envBindings: [envBinding({config:{schema:Schema,mapping:{endpoint:'EAST'}}})] },
					},
				}],
			}))`,
			undefined,
			{
				'/project/control.mjs': renderPluginDescriptors([
					{
						exportName: 'Dynamic',
						descriptor: {
							format: 2,
							definition,
							contracts: { config: null, instance: `sha256:${'a'.repeat(64)}` },
						},
					},
				]),
			},
			{
				async matchesPlugin() {
					throw new Error('the control module should provide the identity')
				},
			},
		)
		const report = await result
		expect(report).toMatchObject({
			status: 'complete',
			value: {
				config: { file: '/project/a.ts' },
				bindings: [{ forkId: 'east', source: { name: 'EAST' } }],
			},
		})
	})

	it('keeps two entry bindings separate and locates config without evaluating application, schemas or reading inputs', async () => {
		const code = (name: string) =>
			application(`services: install(), sources: discover(), plugins: [{
   plugin: P,
   config: computeConfig(),
   envBindings: [envBinding({config: {schema: Schema, mapping: {endpoint: '${name}'}}})],
   fileBindings: [fileBinding({config: {schema: Schema, path: './secret.json'}})],
   }]`)
		const a = inspect(code('FIRST'), '/project/a.ts')
		const b = inspect(code('SECOND'), '/project/b.ts')
		const first = await a.result
		const second = await b.result
		expect(first.status).toBe('complete')
		expect(second.status).toBe('complete')
		if (first.status === 'unavailable' || second.status === 'unavailable')
			throw new Error('unavailable')
		expect(first.value.bindings.map((x) => x.source)).toEqual([
			expect.objectContaining({ kind: 'env', name: 'FIRST' }),
			expect.objectContaining({ kind: 'file', path: './secret.json' }),
		])
		expect(second.value.bindings[0]!.source).toMatchObject({ name: 'SECOND' })
		expect(first.value.config).toMatchObject({ file: '/project/a.ts' })
		expect(first.value.bindings[0]!.schema).toMatchObject({
			symbol: 'Schema',
			declaration: { file: '/project/plugins.ts' },
		})
		expect(a.reads.every((x) => x === '/project/a.ts' || x === '/project/plugins.ts')).toBe(true)
	})
	it('preserves known mapping leaves and independent bindings when expressions and targets are dynamic', async () => {
		const { result } = inspect(
			application(`plugins: [
   {plugin: P, envBindings:[envBinding({config:{schema:Schema,mapping:{ known:'KNOWN', dynamic: chooseName() }}})]},
   {plugin: choosePlugin(), envBindings:[envBinding({config:{schema:Schema,mapping:'MAYBE'}})]},
   {plugin: Q, envBindings:[envBinding({config:{schema:missing,mapping:dynamic()}})]},
  ]`),
		)
		const report = await result
		expect(report.status).toBe('partial')
		if (report.status !== 'partial') throw new Error('not partial')
		expect(report.value.bindings).toHaveLength(1)
		expect(report.value.bindings[0]!.source).toMatchObject({ name: 'KNOWN' })
		expect(report.gaps).toHaveLength(2)
		expect(report.gaps.every((x) => x.location && x.code === 'unsupported_expression')).toBe(true)
	})
	it('keeps binding names even when schema reference is unresolved', async () => {
		const report = await inspect(
			node(`envBindings:[envBinding({config:{schema:Missing,mapping:'NAME'}})]`),
		).result
		expect(report.status).toBe('partial')
		if (report.status !== 'partial') throw new Error('not partial')
		expect(report.value.bindings[0]!.schema.declaration).toBe(null)
		expect(report.value.bindings[0]!.source).toMatchObject({ name: 'NAME' })
		expect(report.gaps[0]!.code).toBe('unresolved_symbol')
	})
	it('does not report bindings as absent when application spread can override declarations', async () => {
		const report = await inspect(application(`plugins: [], ...unknown`)).result
		expect(report.status).toBe('unavailable')
	})
	it('rejects duplicate mapping keys instead of selecting one value', async () => {
		const report = await inspect(
			node(
				`envBindings:[envBinding({config:{schema:Schema,mapping:{endpoint:'ONE',endpoint:'TWO'}}})]`,
			),
		).result
		expect(report.status).toBe('partial')
		if (report.status !== 'partial') throw new Error('not partial')
		expect(report.value.bindings).toEqual([])
		expect(report.gaps[0]!.code).toBe('invalid_declaration')
	})
	it('distinguishes confirmed absence from unsupported declaration shape', async () => {
		const report = await inspect(application(`services: install()`)).result
		expect(report).toMatchObject({
			status: 'complete',
			value: { bindings: [], config: null },
		})
		const unsupported = await inspect(
			`${prefix}\nexport default defineHostApplication(() => chooseApplication())`,
		).result
		expect(unsupported.status).toBe('unavailable')
	})
	it('does not resolve a shadowed Plugin or helper as a module import', async () => {
		const report = await inspect(
			`${prefix}\nexport default defineHostApplication((P) => ({plugins:[{plugin:P,envBindings:[envBinding({config:{schema:Schema,mapping:'WRONG'}})]}]}))`,
		).result
		expect(report.status).toBe('partial')
		if (report.status !== 'partial') throw new Error('not partial')
		expect(report.value.bindings).toEqual([])
		expect(report.gaps[0]!.code).toBe('unresolved_symbol')
	})
	it('reports invalid environment names and duplicate targets with declaration diagnostics', async () => {
		const report = await inspect(
			node(`envBindings:[
   envBinding({config:{schema:Schema,mapping:{valid:'VALID',invalid:'bad-name'}}}),
   envBinding({config:{schema:Schema,mapping:'SECOND'}})
  ]`),
		).result
		expect(report.status).toBe('partial')
		if (report.status !== 'partial') throw new Error('not partial')
		expect(report.gaps.map((x) => x.code)).toEqual(['invalid_declaration', 'invalid_declaration'])
		expect(report.value.bindings.map((x) => x.source)).toEqual([
			expect.objectContaining({ name: 'VALID' }),
		])
	})
	it('propagates query failures through the source resolver instead of downgrading them to gaps', async () => {
		const failure = Object.assign(new Error('budget exhausted'), { code: 'analysis_unavailable' })
		const report = inspect(
			node(`envBindings:[envBinding({config:{schema:Schema,mapping:'NAME'}})]`),
			undefined,
			{},
			{
				async resolve() {
					throw failure
				},
			},
		).result
		await expect(report).rejects.toBe(failure)
	})
	it('keeps unconfirmed target identities as gaps, while identity conflicts reject the query', async () => {
		const code = node(`envBindings:[envBinding({config:{schema:Schema,mapping:'NAME'}})]`)
		const unresolved = await inspect(
			code,
			undefined,
			{},
			{
				async matchesPlugin() {
					throw Object.assign(new Error('unknown target'), { code: 'unresolved_symbol' })
				},
			},
		).result
		expect(unresolved).toMatchObject({
			status: 'partial',
			value: { bindings: [] },
			gaps: [{ code: 'unresolved_symbol' }],
		})
		const conflict = Object.assign(new Error('conflicting sources'), {
			code: 'analysis_unavailable',
		})
		await expect(
			inspect(
				code,
				undefined,
				{},
				{
					async matchesPlugin() {
						throw conflict
					},
				},
			).result,
		).rejects.toBe(conflict)
	})
})
