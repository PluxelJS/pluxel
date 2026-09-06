import {
	formatPluginDefinitionReference,
	type PluginDefinitionAddress,
	type PluginNodeAddress,
} from '@pluxel/core'
import {
	createRuntimeInternalTestHost,
	type RuntimeInternalTestHost,
} from '@pluxel/runtime/internal/test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PluginCatalogLayoutService } from '../../src/services/management/PluginCatalogLayoutService'
import {
	automaticCatalogGroups,
	catalogFamilies,
	type PluginCatalogLayoutEntry,
} from '../../src/services/management/catalog-groups'

const hosts: RuntimeInternalTestHost[] = []
afterEach(async () => {
	vi.restoreAllMocks()
	await Promise.all(hosts.splice(0).map((host) => host.dispose()))
})
const definition = (name: string): PluginDefinitionAddress => ({
	entry: { kind: 'package-root', packageName: `@example/${name.toLowerCase()}` },
	exportName: name,
})
const node = (name: string, forkId?: string): PluginNodeAddress =>
	forkId === undefined
		? { definition: definition(name), variant: 'default' }
		: { definition: definition(name), variant: 'fork', forkId }
const entry = (name: string, requires: string[] = []): PluginCatalogLayoutEntry => ({
	address: node(name),
	requires: requires.map(definition),
})
const ref = (name: string) => formatPluginDefinitionReference(definition(name))
const automatic = (entries: PluginCatalogLayoutEntry[]) =>
	automaticCatalogGroups(catalogFamilies(entries))
function setup() {
	const host = createRuntimeInternalTestHost({
		workbench: false,
		management: true,
		persistence: { mode: 'memory' },
	})
	hosts.push(host)
	return {
		host,
		layout: host.ctx.root.pluginCatalogLayout!,
		storage: host.ctx.root.persistence.namespace('management'),
	}
}
const document = (
	groups: { id: string; name: string; plugins: string[] }[] = [],
	ungrouped: string[] = [],
) => ({ version: 1, groups, ungrouped })

describe('automatic dependency groups', () => {
	it('keeps empty catalogs and unrelated single-package plugins flat, including fork families', () => {
		expect(automatic([])).toEqual([])
		expect(automatic([entry('A'), entry('B'), { address: node('A', 'east') }])).toEqual([])
	})
	it('groups a business entry with its exclusive dependencies across package boundaries', () => {
		const entries = [
			entry('Reports', ['Documents']),
			entry('Documents', ['Storage']),
			entry('Storage'),
			entry('Unrelated'),
		]
		const groups = automatic(entries)
		expect(groups).toHaveLength(1)
		expect(groups[0]).toMatchObject({
			name: 'Reports',
			basis: { kind: 'dependency', definition: definition('Reports') },
		})
		expect(groups[0]!.nodes).toHaveLength(3)
		expect(automatic(entries.toReversed())).toEqual(groups)
	})
	it('keeps shared infrastructure out of separate business groups and propagates sharing transitively', () => {
		const groups = automatic([
			entry('Reports', ['Documents', 'Auth']),
			entry('Documents'),
			entry('Research', ['Dataset', 'Auth']),
			entry('Dataset'),
			entry('Auth', ['Database']),
			entry('Database'),
		])
		expect(
			groups.map((group) => [
				group.name,
				group.nodes.map((address) => address.definition.exportName),
			]),
		).toEqual([
			['Reports', ['Documents', 'Reports']],
			['Research', ['Dataset', 'Research']],
			['共享依赖', ['Auth', 'Database']],
		])
	})
	it('does not classify a diamond inside one business as shared', () => {
		expect(
			automatic([entry('App', ['A', 'B']), entry('A', ['DB']), entry('B', ['DB']), entry('DB')]),
		).toMatchObject([{ name: 'App', nodes: expect.any(Array) }])
	})
	it('uses all declared providers without consulting running selections, and ignores missing dependencies', () => {
		const groups = automatic([
			entry('App', ['Role', 'Absent']),
			{ ...entry('First'), provides: definition('Role') },
			{ ...entry('Second'), provides: definition('Role') },
		])
		expect(groups).toHaveLength(1)
		expect(groups[0]!.nodes).toHaveLength(3)
	})
	it('condenses cycles deterministically and handles long chains without recursion', () => {
		const cycle = [entry('A', ['B']), entry('B', ['A'])]
		expect(automatic(cycle)).toEqual(automatic(cycle.toReversed()))
		expect(automatic(cycle)[0]!.nodes).toHaveLength(2)
		const chain = Array.from({ length: 6000 }, (_, i) =>
			entry(`P${i}`, i < 5999 ? [`P${i + 1}`] : []),
		)
		expect(automatic(chain)[0]!.nodes).toHaveLength(6000)
	})
	it('rejects duplicate nodes and inconsistent family declarations', () => {
		expect(() => automatic([entry('A'), entry('A')])).toThrow('duplicate Plugin node')
		expect(() =>
			automatic([entry('A'), { address: node('A', 'fork'), requires: [definition('B')] }]),
		).toThrow('inconsistent facts')
	})
})

describe('editable group document', () => {
	it('does not allocate management or write defaults just to read a catalog', async () => {
		const disabled = createRuntimeInternalTestHost({ workbench: false })
		hosts.push(disabled)
		expect(disabled.ctx.root.pluginCatalogLayout).toBeUndefined()
		const { layout, storage } = setup()
		expect(await layout.listSections([entry('A', ['B']), entry('B')])).toHaveLength(1)
		expect(await storage.getText('plugin-groups.json')).toBeUndefined()
	})
	it('reads human-editable groups live, honors ungrouped, and automatically groups unspecified plugins', async () => {
		const { layout, storage } = setup()
		const entries = [entry('A'), entry('B'), entry('C', ['D']), entry('D')]
		await storage.put(
			'plugin-groups.json',
			JSON.stringify(document([{ id: 'business', name: '业务', plugins: [ref('B'), ref('A')] }])),
		)
		expect(await layout.listSections(entries)).toMatchObject([
			{ name: '业务', nodes: [node('B'), node('A')] },
			{ name: 'C' },
		])
		await storage.put('plugin-groups.json', JSON.stringify(document([], [ref('C')])))
		expect(await layout.listSections(entries)).toEqual([])
		await storage.delete('plugin-groups.json')
		expect(await layout.listSections(entries)).toMatchObject([{ name: 'C' }])
	})
	it('persists explicit groups and orders as formatted references and round-trips without migration', async () => {
		const { host, layout, storage } = setup()
		const entries = [entry('A'), entry('B'), entry('C')]
		const saved = await layout.updateSections(
			[{ sectionId: 'manual:business', name: '业务', nodes: [node('B'), node('A')] }],
			entries,
		)
		expect(JSON.parse((await storage.getText('plugin-groups.json'))!)).toEqual(
			document([{ id: 'business', name: '业务', plugins: [ref('B'), ref('A')] }], [ref('C')]),
		)
		expect((await storage.getText('plugin-groups.json'))!).toContain('\n  "version"')
		expect(await new PluginCatalogLayoutService(host.ctx).listSections(entries)).toEqual(saved)
		await storage.put('plugin-catalog.json', '{invalid legacy data')
		expect(await layout.listSections(entries)).toEqual(saved)
	})
	it('pins auto groups when saved, preserves manual names on catalog changes, and resets explicitly', async () => {
		const { layout } = setup()
		const entries = [entry('A', ['B']), entry('B')]
		const auto = await layout.listSections(entries)
		const saved = await layout.updateSections(
			auto.map((group) => ({ ...group, name: '业务' })),
			entries,
		)
		expect(saved[0]).toMatchObject({ name: '业务', basis: { kind: 'manual' } })
		expect(await layout.listSections([entry('B')])).toMatchObject([
			{ name: '业务', nodes: [node('B')] },
		])
		expect(await layout.updateSections(null, entries)).toEqual(auto)
	})
	it('keeps absent references dormant and preserves them across edits to a surviving group', async () => {
		const { layout, storage } = setup()
		await storage.put(
			'plugin-groups.json',
			JSON.stringify(document([{ id: 'one', name: 'One', plugins: [ref('Absent'), ref('A')] }])),
		)
		const groups = await layout.listSections([entry('A')])
		expect(groups[0]!.nodes).toEqual([node('A')])
		await layout.updateSections(groups, [entry('A')])
		const restored = await layout.listSections([entry('A'), entry('Absent')])
		expect(restored[0]!.nodes).toEqual([node('A'), node('Absent')])
	})
	it('applies membership to future forks and rejects partial or split families', async () => {
		const { layout } = setup()
		const entries = [entry('A'), { address: node('A', 'east') }]
		await layout.updateSections(
			[{ sectionId: 'manual:one', name: 'One', nodes: entries.map((item) => item.address) }],
			entries,
		)
		const withFork = await layout.listSections([...entries, { address: node('A', 'west') }])
		expect(withFork[0]!.nodes).toHaveLength(3)
		await expect(
			layout.updateSections([{ sectionId: 'one', name: 'One', nodes: [node('A')] }], entries),
		).rejects.toThrow('fork variants')
		await expect(
			layout.updateSections(
				[
					{ sectionId: 'one', name: 'One', nodes: [node('A')] },
					{ sectionId: 'two', name: 'Two', nodes: [node('A', 'east')] },
				],
				entries,
			),
		).rejects.toThrow('fork variants')
	})
	it('rejects malformed file edits without overwriting them and recovers after repair', async () => {
		const { layout, storage } = setup()
		for (const bad of [
			{ version: 2, groups: [], ungrouped: [] },
			document([{ id: 'x', name: 'X', plugins: [ref('A')] }], [ref('A')]),
			document([{ id: 'x', name: 'X', plugins: ['not a reference'] }]),
		]) {
			const content = JSON.stringify(bad)
			await storage.put('plugin-groups.json', content)
			await expect(layout.listSections([entry('A')])).rejects.toThrow(
				/version|duplicate|reference/i,
			)
			expect(await storage.getText('plugin-groups.json')).toBe(content)
		}
		await storage.put('plugin-groups.json', JSON.stringify(document()))
		expect(await layout.listSections([entry('A')])).toEqual([])
	})
	it('does not publish failed writes and serializes queued mutations', async () => {
		const { host, layout } = setup()
		const entries = [entry('A')]
		await layout.updateSections(
			[{ sectionId: 'manual:one', name: 'One', nodes: [node('A')] }],
			entries,
		)
		const namespace = host.ctx.root.persistence.namespace('management')
		vi.spyOn(host.ctx.root.persistence, 'namespace').mockReturnValue({
			...namespace,
			put: async () => {
				throw new Error('disk full')
			},
		})
		const failing = new PluginCatalogLayoutService(host.ctx)
		await expect(failing.updateSections([], entries)).rejects.toThrow('persist')
		expect(await failing.listSections(entries)).toMatchObject([{ name: 'One' }])
		await Promise.all([
			layout.updateSections(
				[{ sectionId: 'manual:one', name: 'First', nodes: [node('A')] }],
				entries,
			),
			layout.updateSections(
				[{ sectionId: 'manual:one', name: 'Second', nodes: [node('A')] }],
				entries,
			),
		])
		expect(await layout.listSections(entries)).toMatchObject([{ name: 'Second' }])
	})
})
