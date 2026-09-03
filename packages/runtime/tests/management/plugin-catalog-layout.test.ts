import type { PluginDefinitionAddress, PluginNodeAddress } from '@pluxel/core'
import {
	createRuntimeInternalTestHost,
	type RuntimeInternalTestHost,
} from '@pluxel/runtime/internal/test'
import { afterEach, describe, expect, it } from 'vitest'

import {
	PluginCatalogLayoutService,
	type PluginCatalogLayoutEntry,
} from '../../src/services/management/PluginCatalogLayoutService'

const hosts: RuntimeInternalTestHost[] = []

afterEach(async () => {
	await Promise.all(hosts.splice(0).map((host) => host.dispose()))
})

function packageDefinition(packageName: string, exportName: string): PluginDefinitionAddress {
	return { entry: { kind: 'package-root', packageName }, exportName }
}

function sourceDefinition(path: string, exportName: string): PluginDefinitionAddress {
	return { entry: { kind: 'source-entry', sourceSpace: 'app', path }, exportName }
}

function node(definition: PluginDefinitionAddress, forkId?: string): PluginNodeAddress {
	return forkId === undefined
		? { definition, variant: 'default' }
		: { definition, variant: 'fork', forkId }
}

function entry(
	definition: PluginDefinitionAddress,
	options: Readonly<{ forkId?: string; provides?: PluginDefinitionAddress }> = {},
): PluginCatalogLayoutEntry {
	return {
		address: node(definition, options.forkId),
		...(options.provides === undefined ? {} : { provides: options.provides }),
	}
}

function createLayout(): PluginCatalogLayoutService {
	const host = createRuntimeInternalTestHost({ workbench: false, management: true })
	hosts.push(host)
	return host.ctx.root.pluginCatalogLayout!
}

describe('Management Plugin catalog layout', () => {
	it('allocates no service or preference file when Management is disabled', async () => {
		const host = createRuntimeInternalTestHost({ workbench: false })
		hosts.push(host)
		expect(host.ctx.root.pluginCatalogLayout).toBeUndefined()
		await expect(
			host.ctx.root.persistence.namespace('management').stat('plugin-catalog.json'),
		).resolves.toBeUndefined()
	})

	it('derives provider, source-directory, and exact-package sections from catalog facts', async () => {
		const providerRole = packageDefinition('@roles/render', 'RenderProvider')
		const providerA = packageDefinition('@vendor/webgl', 'WebglRenderer')
		const providerB = sourceDefinition('src/render/canvas.ts', 'CanvasRenderer')
		const sourcePeer = sourceDefinition('src/render/fonts.ts', 'FontsPlugin')
		const sourceOther = sourceDefinition('src/auth/oidc.ts', 'OidcPlugin')
		const sourceNested = sourceDefinition('src/render/internal/debug.ts', 'DebugPlugin')
		const sourceRoot = sourceDefinition('root.ts', 'RootPlugin')
		const packageA = packageDefinition('@vendor/tools', 'ToolA')
		const packageB = packageDefinition('@vendor/tools', 'ToolB')

		await expect(
			createLayout().listSections([
				entry(providerA, { provides: providerRole }),
				entry(providerB, { provides: providerRole }),
				entry(sourcePeer),
				entry(sourceOther),
				entry(sourceNested),
				entry(sourceRoot),
				entry(packageA),
				entry(packageB),
			]),
		).resolves.toEqual([
			{
				sectionId: 'provider:package:@roles/render::RenderProvider',
				name: 'RenderProvider',
				basis: { kind: 'provider', definition: providerRole },
				nodes: [node(providerA), node(providerB)],
			},
			{
				sectionId: 'source:app',
				name: 'app',
				basis: { kind: 'source-directory', sourceSpace: 'app', path: '' },
				nodes: [node(sourceRoot)],
			},
			{
				sectionId: 'source:app/src/auth',
				name: 'auth',
				basis: { kind: 'source-directory', sourceSpace: 'app', path: 'src/auth' },
				nodes: [node(sourceOther)],
			},
			{
				sectionId: 'source:app/src/render/internal',
				name: 'internal',
				basis: {
					kind: 'source-directory',
					sourceSpace: 'app',
					path: 'src/render/internal',
				},
				nodes: [node(sourceNested)],
			},
			{
				sectionId: 'source:app/src/render',
				name: 'render',
				basis: { kind: 'source-directory', sourceSpace: 'app', path: 'src/render' },
				nodes: [node(sourcePeer)],
			},
			{
				sectionId: 'package:@vendor/tools',
				name: '@vendor/tools',
				basis: { kind: 'package', packageName: '@vendor/tools' },
				nodes: [node(packageA), node(packageB)],
			},
		])
	})

	it('recomputes derived sections as dynamic definitions enter and leave the catalog', async () => {
		const layout = createLayout()
		const first = sourceDefinition('src/render/first.ts', 'First')
		const second = sourceDefinition('src/render/second.ts', 'Second')
		const auth = sourceDefinition('src/auth/index.ts', 'Auth')

		await expect(layout.listSections([entry(first)])).resolves.toHaveLength(1)
		await expect(layout.listSections([entry(first), entry(second), entry(auth)])).resolves.toEqual([
			expect.objectContaining({ sectionId: 'source:app/src/auth', nodes: [node(auth)] }),
			expect.objectContaining({
				sectionId: 'source:app/src/render',
				nodes: [node(first), node(second)],
			}),
		])
		await expect(layout.listSections([entry(auth)])).resolves.toEqual([
			expect.objectContaining({ sectionId: 'source:app/src/auth', nodes: [node(auth)] }),
		])
	})

	it('rejects duplicate nodes and inconsistent declaration facts', async () => {
		const layout = createLayout()
		const plugin = packageDefinition('@vendor/plugin', 'Plugin')
		const role = packageDefinition('@roles/example', 'ExampleProvider')

		await expect(layout.listSections([entry(plugin), entry(plugin)])).rejects.toThrow(
			'duplicate Plugin node',
		)
		await expect(
			layout.listSections([entry(plugin), entry(plugin, { forkId: 'fork', provides: role })]),
		).rejects.toThrow('inconsistent facts')
	})

	it('stores placement and ordering preferences without permitting invented sections', async () => {
		const layout = createLayout()
		const renderA = sourceDefinition('src/render/a.ts', 'A')
		const renderB = sourceDefinition('src/render/b.ts', 'B')
		const auth = sourceDefinition('src/auth/index.ts', 'Auth')
		const entries = [entry(renderA), entry(renderB), entry(auth)]

		await expect(
			layout.updateSections(
				[
					{ sectionId: 'source:app/src/render', nodes: [node(auth), node(renderB)] },
					{ sectionId: 'source:app/src/auth', nodes: [] },
				],
				entries,
			),
		).resolves.toEqual([
			expect.objectContaining({
				sectionId: 'source:app/src/render',
				nodes: [node(auth), node(renderB)],
			}),
			expect.objectContaining({ sectionId: 'source:app/src/auth', nodes: [] }),
		])

		await expect(
			layout.updateSections(
				[{ sectionId: 'source:app/src/render', nodes: [node(renderB), node(auth)] }],
				entries,
			),
		).resolves.toEqual([
			expect.objectContaining({
				sectionId: 'source:app/src/render',
				nodes: [node(renderB), node(auth)],
			}),
			expect.objectContaining({ sectionId: 'source:app/src/auth', nodes: [] }),
		])

		await expect(
			layout.updateSections([{ sectionId: 'invented', nodes: [] }], entries),
		).rejects.toMatchObject({ code: 'INVALID_PLUGIN_CATALOG_LAYOUT' })
		await expect(
			layout.updateSections(
				[
					{
						sectionId: 'source:app/src/render',
						nodes: [node(packageDefinition('@missing/x', 'X'))],
					},
				],
				entries,
			),
		).rejects.toMatchObject({ code: 'INVALID_PLUGIN_CATALOG_LAYOUT' })
	})

	it('falls back to the derived section while a preferred target is absent', async () => {
		const layout = createLayout()
		const render = sourceDefinition('src/render/index.ts', 'Render')
		const auth = sourceDefinition('src/auth/index.ts', 'Auth')
		const both = [entry(render), entry(auth)]

		await layout.updateSections(
			[
				{ sectionId: 'source:app/src/render', nodes: [node(render), node(auth)] },
				{ sectionId: 'source:app/src/auth', nodes: [] },
			],
			both,
		)
		await expect(layout.listSections([entry(auth)])).resolves.toEqual([
			expect.objectContaining({ sectionId: 'source:app/src/auth', nodes: [node(auth)] }),
		])
		await expect(layout.listSections(both)).resolves.toEqual([
			expect.objectContaining({
				sectionId: 'source:app/src/render',
				nodes: [node(render), node(auth)],
			}),
			expect.objectContaining({ sectionId: 'source:app/src/auth', nodes: [] }),
		])
	})

	it('keeps every fork in one definition family and applies preferences to future forks', async () => {
		const layout = createLayout()
		const family = packageDefinition('@vendor/family', 'Family')
		const other = sourceDefinition('src/other/index.ts', 'Other')
		const entries = [entry(family), entry(family, { forkId: 'east' }), entry(other)]

		await expect(
			layout.updateSections(
				[
					{ sectionId: 'source:app/src/other', nodes: [node(family), node(family, 'east')] },
					{ sectionId: 'package:@vendor/family', nodes: [] },
				],
				entries,
			),
		).resolves.toEqual([
			expect.objectContaining({
				sectionId: 'source:app/src/other',
				nodes: [node(family), node(family, 'east')],
			}),
			expect.objectContaining({ sectionId: 'package:@vendor/family', nodes: [] }),
		])

		await expect(
			layout.listSections([...entries, entry(family, { forkId: 'west' })]),
		).resolves.toEqual([
			expect.objectContaining({
				sectionId: 'source:app/src/other',
				nodes: [node(family), node(family, 'east'), node(family, 'west')],
			}),
			expect.objectContaining({ sectionId: 'package:@vendor/family', nodes: [] }),
		])

		await expect(
			layout.updateSections(
				[
					{ sectionId: 'source:app/src/other', nodes: [node(family)] },
					{ sectionId: 'package:@vendor/family', nodes: [node(family, 'east')] },
				],
				entries,
			),
		).rejects.toMatchObject({ code: 'INVALID_PLUGIN_CATALOG_LAYOUT' })
	})

	it('rejects old preference versions and ignores preferences for absent definitions', async () => {
		const legacyHost = createRuntimeInternalTestHost({ workbench: false })
		hosts.push(legacyHost)
		await legacyHost.ctx.root.persistence
			.namespace('management')
			.put(
				'plugin-catalog.json',
				JSON.stringify({ version: 3, placements: [], sectionOrder: [], definitionOrder: [] }),
			)
		await expect(new PluginCatalogLayoutService(legacyHost.ctx).ready).rejects.toThrow(
			'preferences version must be 4',
		)

		const host = createRuntimeInternalTestHost({ workbench: false })
		hosts.push(host)
		const orphan = sourceDefinition('src/orphan/index.ts', 'Orphan')
		await host.ctx.root.persistence.namespace('management').put(
			'plugin-catalog.json',
			JSON.stringify({
				version: 4,
				placements: [{ definition: orphan, sectionId: null }],
				sectionOrder: ['source:app/src/orphan'],
				definitionOrder: [{ sectionId: 'source:app/src/orphan', definitions: [orphan] }],
			}),
		)
		await expect(new PluginCatalogLayoutService(host.ctx).listSections([])).resolves.toEqual([])
	})
})
