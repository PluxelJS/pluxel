import { createFixture } from 'fs-fixture'
import { describe, expect, it } from 'vitest'
import {
	createPluginSemanticsPlugin,
	inspectPluginSource,
} from '../../src/rolldown/plugins/pluginSemanticsPlugin'

const code = `
import { BasePlugin, PluginPart, Plugin, definePluginRef } from '@pluxel/core'
import { ExternalPart } from '@acme/parts'
import { SearchPlugin } from '@acme/search'
import type { AuditPlugin } from '@acme/audit'
const Audit = definePluginRef<AuditPlugin>()
class Leaf extends PluginPart<Branch> {
 constructor(readonly search: SearchPlugin) { super() }
 override init() { this.plugins.use(Audit, audit => void audit) }
}
class Branch extends PluginPart<Owner> { readonly leaf = this.parts.use(Leaf) }
@Plugin() export class Owner extends BasePlugin {
 readonly external = this.parts.use(ExternalPart)
 readonly branch = this.parts.use(Branch)
 readonly second = this.parts.use(Branch)
}
`

describe('inspection and transform semantic parity', () => {
	it.each([false, true])(
		'shares definitions and Part relationships with transforms (package source root: %s)',
		async (packageRoot) => {
			await using fixture = await createFixture({
				'package.json': JSON.stringify({
					name: '@fixture/parity',
					...(packageRoot ? { exports: { '.': { '@pluxel/source': './src/index.ts' } } } : {}),
				}),
				'src/index.ts': code,
			})
			const root = fixture.getPath()
			const id = fixture.getPath('src/index.ts')
			const sourceSpaces = [{ name: 'managed', root: 'src' }]
			const collector = createPluginSemanticsPlugin({ root, sourceSpaces })
			const transform = collector.plugin.transform as {
				handler(this: unknown, code: string, id: string): Promise<{ code: string } | null>
			}
			const lowered = await transform.handler.call(
				{
					error(message: string): never {
						throw new Error(message)
					},
					async resolve(): Promise<null> {
						return null
					},
				},
				code,
				id,
			)
			const inspected = await inspectPluginSource({ moduleId: id, root, sourceSpaces })
			const expected = packageRoot
				? { entry: { kind: 'package-root', packageName: '@fixture/parity' }, exportName: 'Owner' }
				: {
						entry: { kind: 'source-entry', sourceSpace: 'managed', path: 'index.ts' },
						exportName: 'Owner',
					}
			expect(
				inspected.definitions.map(
					({ moduleId: _moduleId, start: _start, end: _end, ...definition }) => definition,
				),
			).toEqual(collector.definitions())
			expect(inspected.definitions).toMatchObject([
				{ className: 'Owner', definition: expected, requires: [], optional: [] },
			])
			const owner = inspected.owners.find((x) => x.className === 'Owner')!
			expect(
				owner.parts.map((x) => ({ fieldName: x.fieldName, target: x.target?.className })),
			).toEqual([
				{ fieldName: 'external', target: undefined },
				{ fieldName: 'branch', target: 'Branch' },
				{ fieldName: 'second', target: 'Branch' },
			])
			expect(inspected.owners.find((x) => x.className === 'Branch')!.parts).toMatchObject([
				{ fieldName: 'leaf', target: { className: 'Leaf' } },
			])
			expect(inspected.owners.find((x) => x.className === 'Leaf')).toMatchObject({
				requires: [
					{
						entry: { kind: 'package-root', packageName: '@acme/search' },
						exportName: 'SearchPlugin',
					},
				],
				optional: [
					{
						entry: { kind: 'package-root', packageName: '@acme/audit' },
						exportName: 'AuditPlugin',
					},
				],
			})
			expect(collector.snapshot()).toEqual(
				new Map([
					['@acme/search', 'required'],
					['@acme/audit', 'optional'],
				]),
			)
			expect(lowered?.code).toContain('__pluxelSetPluginParts(Owner,')
			expect(lowered?.code).toContain('__pluxelSetPluginPartRequires(Leaf,')
			expect(lowered?.code).toContain('__pluxelSetPluginPartOptional(Leaf,')
			expect(lowered?.code).toContain(JSON.stringify(expected))
			expect(inspected.files.find((x) => x.id === id)!.code).toBe(code)
			expect(inspected).not.toHaveProperty('transformedCode')
		},
	)
	it('does not convert a manifest read blocked by budget into a source-entry identity', async () => {
		await using fixture = await createFixture({
			'package.json': JSON.stringify({
				name: '@fixture/budget',
				exports: { '.': { '@pluxel/source': './plugin.ts' } },
			}),
			'plugin.ts': `import {BasePlugin,Plugin} from '@pluxel/core'; @Plugin() export class P extends BasePlugin {}`,
		})
		await expect(
			inspectPluginSource({
				moduleId: fixture.getPath('plugin.ts'),
				root: fixture.getPath(),
				maxFiles: 1,
			}),
		).rejects.toThrow(/budget/)
	})
})
