import { symlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createDiskFixture } from '@pluxel/test/fixtures'
import { Checker } from 'typescript/unstable/sync'
import { expect, it, vi } from 'vitest'
import { createControlInspector } from '../src/control/inspect-interface'

it('inspects generated declarations across aliases, generic inheritance and overloads', async () => {
	const declarations = {
		'entry.d.mts': "export type { Owner as PluginInstance } from './class.js'",
		'class.d.ts': `
import type { Input, Modes } from './request.js'
declare abstract class Base<T> {
    /** Fetched item. */
    getItem(id: string): Promise<T>;
    protected setup(): void;
}
export declare class Owner extends Base<Input> {
    private hidden;
    protected secret: number;
    static create(): Owner;
    /** Render once.
     * @param request Work to run.
     */
    render(request: Input): Promise<Input>;
    render<M extends Modes>(request: Input, mode: M): M;
    readonly last: Input;
    errors(): Error;
    lease(): Owner;
}
`,
		'request.d.ts': `
export declare const modes: readonly ['light', 'dark'];
export type Modes = typeof modes[number];
export type Input = Readonly<{ mode: Modes; previous?: Input }>;
`,
	}
	await using fixture = await createDiskFixture({ ...declarations, 'manifest.json': '{}' })
	const declaration = resolve(fixture.path, 'entry.d.mts')
	using inspector = createControlInspector({
		root: fixture.path,
		files: new Map(Object.entries(declarations)),
		declarations: [declaration],
	})
	const target = { declaration, instanceExport: 'PluginInstance' }
	const overview = inspector.inspect(target)
	expect(overview.members.map((p) => p.name).sort()).toEqual([
		'errors',
		'getItem',
		'last',
		'lease',
		'render',
	])
	expect(overview.types).toEqual([])
	const inherited = overview.members.find((p) => p.name === 'getItem')!.signatures[0]
	expect(inherited).toContain('getItem(id: string): Promise<')
	expect(inherited).toMatch(/Input|mode: Modes/)
	expect(inherited).not.toMatch(/\bT\b/)
	const detail = inspector.inspect({ ...target, member: 'render' })
	expect(detail.members).toHaveLength(1)
	expect(detail.members[0].signatures).toEqual([
		'render(request: Input): Promise<Input>;',
		'render<M extends Modes>(request: Input, mode: M): M;',
	])
	expect(detail.members[0].documentation).toContain('@param request Work to run.')
	expect(detail.types.map((t) => t.name).sort()).toEqual(['Input', 'Modes', 'modes'])
	expect(detail.types.find((t) => t.name === 'modes')).toMatchObject({
		source: 'request.d.ts',
		line: 2,
		declaration: expect.stringContaining("'light', 'dark'"),
	})
	expect(detail.omittedTypes).toEqual([])
	expect(inspector.inspect({ ...target, member: 'errors' }).types).toEqual([])
	expect(inspector.inspect({ ...target, member: 'lease' }).omittedTypes).toContainEqual({
		name: 'Owner',
		source: 'class.d.ts',
		line: 8,
	})
	expect(() => inspector.inspect({ ...target, member: 'hidden' })).toThrow(RangeError)
})

it('reports instantiated types for inherited accessors, callbacks and nested results', async () => {
	const source = `
export interface Order { id: string }
declare class Base<T> {
  get current(): T;
  set current(value: T | null);
  changes(listener: (value: T) => void): void;
  snapshot(): { rows: { [key: string]: T } };
}
export declare class StoreInstance extends Base<Order> {}
`
	await using fixture = await createDiskFixture({ 'entry.d.mts': source, 'manifest.json': '{}' })
	const declaration = resolve(fixture.path, 'entry.d.mts')
	using inspector = createControlInspector({
		root: fixture.path,
		files: new Map([['entry.d.mts', source]]),
		declarations: [declaration],
	})
	const inspect = (member: string) =>
		inspector.inspect({ declaration, instanceExport: 'StoreInstance', member })
	const accessor = inspect('current')
	expect(accessor.members[0]?.signatures).toEqual([
		'get current(): Order;',
		'set current(value: Order | null);',
	])
	for (const report of [accessor, inspect('changes'), inspect('snapshot')]) {
		expect(report.types.map((type) => type.name)).toContain('Order')
	}
})

it('preserves all original overloads and their locations if the compiler cannot print a signature', async () => {
	const source = [
		'export declare class Base<T> {',
		'  read(value: T): T;',
		'  read(values: T[]): T[];',
		'}',
		'export declare class StoreInstance extends Base<number> {}',
	].join('\n')
	await using fixture = await createDiskFixture({ 'entry.d.mts': source, 'manifest.json': '{}' })
	const declaration = resolve(fixture.path, 'entry.d.mts')
	using inspector = createControlInspector({
		root: fixture.path,
		files: new Map([['entry.d.mts', source]]),
		declarations: [declaration],
	})
	using printer = vi.spyOn(Checker.prototype, 'signatureToSignatureDeclaration')
	printer.mockImplementationOnce(() => {
		throw new RangeError('Offset is outside the bounds of the DataView')
	})
	const {
		members: [member],
	} = inspector.inspect({ declaration, instanceExport: 'StoreInstance', member: 'read' })
	expect(member.signatures).toEqual(['read(value: T): T;', 'read(values: T[]): T[];'])
	expect(member.declaredIn).toEqual(
		[2, 3].map((line) => ({ name: 'Base', source: 'entry.d.mts', line })),
	)
})

it('resolves a linked service package and its transitive public declaration dependency', async () => {
	const entry = "export type { Service as ServiceInstance } from 'installed-service'"
	await using fixture = await createDiskFixture({
		'receiver/control/index.d.mts': entry,
		'receiver/control/manifest.json': '{}',
		'receiver/node_modules/.keep': '',
		'workspace/service/package.json': '{"name":"installed-service","types":"index.d.ts"}',
		'workspace/service/index.d.ts':
			"import type { Row } from 'records'; export declare class Service { list(): Row[] }",
		'workspace/node_modules/records/package.json': '{"name":"records","types":"index.d.ts"}',
		'workspace/node_modules/records/index.d.ts': 'export interface Row { id: string }',
	})
	await symlink(
		resolve(fixture.path, 'workspace/service'),
		resolve(fixture.path, 'receiver/node_modules/installed-service'),
		'dir',
	)
	const root = resolve(fixture.path, 'receiver/control')
	const declaration = resolve(root, 'index.d.mts')
	using inspector = createControlInspector({
		root,
		files: new Map([['index.d.mts', entry]]),
		declarations: [declaration],
	})
	const report = inspector.inspect({
		declaration,
		instanceExport: 'ServiceInstance',
		kind: 'service',
		member: 'list',
	})
	expect(report.types).toMatchObject([
		{ name: 'Row', declaration: 'export interface Row { id: string }' },
	])
})

it('follows the package public self-reference and reports missing declaration dependencies', async () => {
	const declarationText =
		"import type { Published } from '@test/published'; export type OnlyInstance = Published"
	await using fixture = await createDiskFixture({
		'package.json': JSON.stringify({
			name: '@test/published',
			type: 'module',
			exports: { '.': { types: './dist/index.d.mts', import: './dist/index.mjs' } },
			pluxel: { control: './dist/control/manifest.json' },
		}),
		'dist/control/manifest.json': '{}',
		'dist/control/index.d.mts': declarationText,
		'dist/index.mjs': "throw new Error('plugin implementation evaluated')",
		'dist/index.d.mts': `import type { Missing } from 'absent-dependency'
export interface Input { amount: number }
export declare class Published {
    copy(value: Input): Promise<Input>
    missing(): Promise<Missing>
}
`,
	})
	const root = resolve(fixture.path, 'dist/control')
	const declaration = resolve(root, 'index.d.mts')
	using inspector = createControlInspector({
		root,
		files: new Map([['index.d.mts', declarationText]]),
		declarations: [declaration],
	})
	const target = { declaration, instanceExport: 'OnlyInstance' }
	const result = inspector.inspect({ ...target, member: 'copy' })
	expect(result.types).toEqual([
		expect.objectContaining({
			name: 'Input',
			source: resolve(fixture.path, 'dist/index.d.mts'),
			line: 2,
		}),
	])
	expect(() => inspector.inspect(target)).toThrow(/declaration dependencies/)
	expect(() => inspector.inspect({ ...target, member: 'missing' })).toThrow(
		/declaration dependencies/,
	)
})

it('retains a usable declaration location for data beyond the detail budget', async () => {
	const count = 21
	const source = Array.from(
		{ length: count },
		(_, i) => `export interface Item${i} { next: ${i + 1 === count ? 'number' : `Item${i + 1}`} }`,
	).join('\n')
	const code = `${source}\nexport declare class LargeInstance { read(): Item0 }`
	await using fixture = await createDiskFixture({ 'manifest.json': '{}', 'index.d.mts': code })
	const declaration = resolve(fixture.path, 'index.d.mts')
	using inspector = createControlInspector({
		root: fixture.path,
		files: new Map([['index.d.mts', code]]),
		declarations: [declaration],
	})
	const result = inspector.inspect({ declaration, instanceExport: 'LargeInstance', member: 'read' })
	expect(result.types).toHaveLength(16)
	expect(result.omittedTypes).toEqual([{ name: 'Item16', source: 'index.d.mts', line: 17 }])
})

it('recovers input/output and schema expressions across per-entry and material re-exports', async () => {
	const declarationText = `
type Shared = {readonly source:'shared.ts';readonly name:'schema';readonly declaration:'const schema = v.optional(v.number(), 3)'}
type Section<P extends readonly string[]> = {
 readonly path:P; readonly source:'plugin.ts';readonly className:'Plugin';
 readonly expression:'schema'; readonly dependencies: readonly [Shared]
}
export type PluginConfigDeclaration = readonly [Section<readonly []>, Section<readonly ['part']>]
`
	const declarations = {
		'config.d.mts': declarationText,
		'entry.d.mts': `
export type {PluginConfigDeclaration} from './config.mjs'
type I<S extends {in:unknown}> = S['in']
type O<S extends {out:unknown}> = S['out']
type Schema = {in:{count?:number}; out:{count:number}}
export type PluginConfigInput = I<Schema>
export type PluginConfigOutput = O<Schema>
`,
		'sync.d.mts':
			"export type {PluginConfigInput as ChosenConfigInput,PluginConfigOutput as ChosenConfigOutput,PluginConfigDeclaration as ChosenConfigDeclaration} from './entry.mjs'",
	}
	await using fixture = await createDiskFixture({ ...declarations, 'manifest.json': '{}' })
	const declaration = resolve(fixture.path, 'sync.d.mts')
	using inspector = createControlInspector({
		root: fixture.path,
		files: new Map(Object.entries(declarations)),
		declarations: [declaration],
	})
	const result = inspector.inspectConfig({ declaration, exportName: 'Chosen' })
	expect(result.input).toMatch(/count\?:\s*number/)
	expect(result.output).toMatch(/count:\s*number/)
	expect(result.sources.map((s) => [s.path, s.expression, s.dependencies])).toEqual([
		[[], 'schema', [0]],
		[['part'], 'schema', [0]],
	])
	expect(result.dependencies).toEqual([
		{
			source: 'shared.ts',
			name: 'schema',
			declaration: 'const schema = v.optional(v.number(), 3)',
		},
	])
})
