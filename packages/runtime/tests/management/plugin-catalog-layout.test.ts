import { afterEach, describe, expect, it } from 'vitest'
import { pluginDefinitionIndexKey, pluginNodeAddressOf } from '@pluxel/core'
import { requirePluginService } from '@pluxel/core/internal'
import { BasePlugin, createRuntimeHost, Plugin, type RuntimeHost } from '@pluxel/runtime/test'
import { requireRuntimePluginGraphCoordinator } from '../../src/internal/reconciliation'
import {
	installRuntimeRouteCapabilities,
	type RuntimePluginSource,
} from '../../src/runtime/capabilities'
import { lowerTestPlugin } from '../helpers/lowered-plugin'

const hosts: RuntimeHost[] = []

afterEach(async () => {
	await Promise.all(hosts.splice(0).map((host) => host.dispose()))
})

function packageSource(packageName: string): RuntimePluginSource {
	return {
		__typename: 'PluginSourceInfo',
		kind: 'package',
		moduleId: packageName,
		packageName,
		version: '1.0.0',
		tag: null,
	}
}

function installSourceMap(host: RuntimeHost, packages: Readonly<Record<string, string>>): void {
	const uninstall = installRuntimeRouteCapabilities(host.ctx, {
		source: {
			resolveSource(address) {
				const displayName = requireRuntimePluginGraphCoordinator(host.ctx)
					.catalogSnapshot()
					.byDefinition.get(pluginDefinitionIndexKey(address.definition))?.candidate
					.declaration.displayName
				const packageName = displayName ? packages[displayName] : undefined
				return packageName
					? packageSource(packageName)
					: {
							__typename: 'PluginSourceInfo',
							kind: 'unknown',
							moduleId: null,
							packageName: null,
							version: null,
							tag: null,
						}
			},
		},
	})
	host.ctx.effects.defer(uninstall, { tag: 'test-source-map' })
}

describe('Management Plugin catalog layout', () => {
	it('has no catalog layout service or preference file when management is disabled', async () => {
		const host = createRuntimeHost({ workbench: false })
		hosts.push(host)
		expect(host.ctx.workbench).toBeUndefined()
		expect(host.ctx.root.pluginCatalogLayout).toBeUndefined()
		await expect(
			host.ctx.root.persistence.namespace('management').stat('plugin-catalog.json'),
		).resolves.toBeUndefined()
	})

	it('classifies fixed plugins first, host package families second, and exact packages last', async () => {
		@Plugin({ displayName: 'FixedChatPlugin' })
		class FixedChatPlugin extends BasePlugin {}
		@Plugin({ displayName: 'SuitePackagePlugin' })
		class SuitePackagePlugin extends BasePlugin {}
		@Plugin({ displayName: 'VendorPluginA' })
		class VendorPluginA extends BasePlugin {}
		@Plugin({ displayName: 'VendorPluginB' })
		class VendorPluginB extends BasePlugin {}
		for (const PluginCtor of [FixedChatPlugin, SuitePackagePlugin, VendorPluginA, VendorPluginB]) {
			lowerTestPlugin(PluginCtor)
		}

		const host = createRuntimeHost({
			workbench: false,
			management: {
				pluginGroups: [
					{
						id: 'chatbots',
						name: 'Chatbots',
						definitions: [pluginNodeAddressOf(FixedChatPlugin).definition],
						packages: ['@suite/chat-*'],
					},
				],
			},
		})
		hosts.push(host)
		host.add([FixedChatPlugin, SuitePackagePlugin, VendorPluginA, VendorPluginB])
		installSourceMap(host, {
			SuitePackagePlugin: '@suite/chat-telegram',
			VendorPluginA: '@vendor/tools',
			VendorPluginB: '@vendor/tools',
		})
		await host.commit()

		expect(host.ctx.workbench).toBeUndefined()
		const catalog = host.ctx.root.pluginCatalogLayout
		expect(catalog).toBeDefined()
		await expect(catalog!.listGroups()).resolves.toEqual([
			{
				groupId: 'chatbots',
				name: 'Chatbots',
				nodes: [pluginNodeAddressOf(FixedChatPlugin), pluginNodeAddressOf(SuitePackagePlugin)],
			},
			{
				groupId: 'package:@vendor/tools',
				name: '@vendor/tools',
				nodes: [pluginNodeAddressOf(VendorPluginA), pluginNodeAddressOf(VendorPluginB)],
			},
		])
	})

	it('stores user moves as overrides while keeping the group registry closed', async () => {
		@Plugin({ displayName: 'HostDefaultPlugin' })
		class HostDefaultPlugin extends BasePlugin {}
		@Plugin({ displayName: 'PackageDefaultPlugin' })
		class PackageDefaultPlugin extends BasePlugin {}
		lowerTestPlugin(HostDefaultPlugin)
		lowerTestPlugin(PackageDefaultPlugin)

		const host = createRuntimeHost({
			workbench: false,
			management: {
				pluginGroups: [
					{
						id: 'host',
						name: 'Host',
						definitions: [pluginNodeAddressOf(HostDefaultPlugin).definition],
					},
				],
			},
		})
		hosts.push(host)
		host.add([HostDefaultPlugin, PackageDefaultPlugin])
		installSourceMap(host, { PackageDefaultPlugin: '@vendor/pkg' })
		await host.commit()

		const catalog = host.ctx.root.pluginCatalogLayout!
		await expect(
			catalog.updateGroups([
				{ groupId: 'host', name: 'Host', nodes: [pluginNodeAddressOf(PackageDefaultPlugin)] },
				{ groupId: 'package:@vendor/pkg', name: '@vendor/pkg', nodes: [] },
			]),
		).resolves.toEqual([
			{ groupId: 'host', name: 'Host', nodes: [pluginNodeAddressOf(PackageDefaultPlugin)] },
			{ groupId: 'package:@vendor/pkg', name: '@vendor/pkg', nodes: [] },
		])

		await expect(
			catalog.updateGroups([
				{ groupId: 'invented', name: 'Invented', nodes: [pluginNodeAddressOf(HostDefaultPlugin)] },
			]),
		).rejects.toMatchObject({ code: 'INVALID_PLUGIN_GROUP_LAYOUT' })
		await expect(
			catalog.updateGroups([
				{ groupId: 'host', name: 'Renamed', nodes: [pluginNodeAddressOf(HostDefaultPlugin)] },
			]),
		).rejects.toMatchObject({ code: 'INVALID_PLUGIN_GROUP_LAYOUT' })
	})

	it('rejects unsupported catalog preference versions', async () => {
		const host = createRuntimeHost({ workbench: false, management: {} })
		hosts.push(host)
		await host.ctx.root.persistence
			.namespace('management')
			.put(
				'plugin-catalog.json',
				JSON.stringify({ version: 1, assignments: [], groupOrder: [], pluginOrder: [] }),
			)
		const catalog = host.ctx.root.pluginCatalogLayout!
		await expect(catalog.ready).rejects.toThrow('preferences version must be 3')
	})

	it('does not materialize an orphan node while loading catalog preferences', async () => {
		const host = createRuntimeHost({ workbench: false, management: {} })
		hosts.push(host)
		const orphan = {
			definition: {
				entry: {
					kind: 'source-entry',
					sourceSpace: 'app',
					path: 'pluxel-test:orphan-preference',
				},
				exportName: 'Plugin',
			},
			variant: 'default',
		} as const
		await host.ctx.root.persistence.namespace('management').put(
			'plugin-catalog.json',
			JSON.stringify({
				version: 3,
				assignments: [{ definition: orphan.definition, groupId: null }],
				groupOrder: [],
				pluginOrder: [{ groupId: 'missing', definitions: [orphan.definition] }],
			}),
		)
		const pluginService = requirePluginService(host.ctx)
		expect(pluginService.resolvePluginNode(orphan)).toBeUndefined()

		const catalog = host.ctx.root.pluginCatalogLayout!
		await expect(catalog.listGroups()).resolves.toEqual([])

		expect(pluginService.resolvePluginNode(orphan)).toBeUndefined()
	})

	it('loads definition preferences inherited by every fork', async () => {
		@Plugin({ displayName: 'FamilyPlugin', forkable: true })
		class FamilyPlugin extends BasePlugin {}
		lowerTestPlugin(FamilyPlugin)

		const host = createRuntimeHost({
			workbench: false,
			management: {
				pluginGroups: [{ id: 'family', name: 'Family' }],
			},
		})
		hosts.push(host)
		const East = host.fork(FamilyPlugin, 'east')
		host.add(FamilyPlugin)
		installSourceMap(host, {})
		await host.commit()

		const owner = pluginNodeAddressOf(FamilyPlugin)
		const storage = host.ctx.root.persistence.namespace('management')
		await storage.put(
			'plugin-catalog.json',
			JSON.stringify({
				version: 3,
				assignments: [{ definition: owner.definition, groupId: 'family' }],
				groupOrder: ['family'],
				pluginOrder: [{ groupId: 'family', definitions: [owner.definition] }],
			}),
		)

		const catalog = host.ctx.root.pluginCatalogLayout!
		await expect(catalog.listGroups()).resolves.toEqual([
			{
				groupId: 'family',
				name: 'Family',
				nodes: [pluginNodeAddressOf(FamilyPlugin), East],
			},
		])
	})

	it('rejects ambiguous host rules during management plan compilation', () => {
		expect(() =>
			createRuntimeHost({
				workbench: false,
				management: {
					pluginGroups: [
						{ id: 'one', name: 'One', packages: ['@vendor/pkg'] },
						{ id: 'two', name: 'Two', packages: ['@vendor/pkg*'] },
					],
				},
			}),
		).toThrow('duplicates a rule')
	})
})
