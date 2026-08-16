import { afterEach, describe, expect, it } from 'vitest'
import { pluginNodeAddressOf } from '@pluxel/core'
import {
	BasePlugin,
	createRuntimeHost,
	getPluginInfo,
	Plugin,
	type RuntimeHost,
} from '@pluxel/runtime/test'
import type { RuntimePluginSource } from '../../src/runtime/capabilities'
import { requireWorkbench } from '../../src/services/workbench'
import { WorkbenchPluginCatalogService } from '../../src/services/workbench/WorkbenchPluginCatalogService'
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
	const key = (address: ReturnType<typeof pluginNodeAddressOf>) => JSON.stringify(address)
	const registered = () =>
		host.plugins().map((ctor) => {
			const info = getPluginInfo(ctor)
			return {
				address: pluginNodeAddressOf(ctor),
				ctor,
				displayName: info.displayName,
				rootExportName: info.rootExportName,
			}
		})
	host.ctx.runtimeRoute = {
		catalog: {
			resolve(address) {
				return registered().find((entry) => key(entry.address) === key(address))?.ctor
			},
			resolveDefinition(definition) {
				return registered().find(
					(entry) => JSON.stringify(entry.address.definition) === JSON.stringify(definition),
				)?.ctor
			},
			require(address) {
				const ctor = registered().find((entry) => key(entry.address) === key(address))?.ctor
				if (!ctor) throw new Error(`missing test plugin: ${key(address)}`)
				return ctor
			},
			listRegistered: registered,
		},
		lifecycle: {
			isRunning(address) {
				const ctor = registered().find((entry) => key(entry.address) === key(address))?.ctor
				return ctor ? host.isRunning(ctor) : false
			},
			enable: () => undefined,
			enablePersisted: () => undefined,
			deactivate: () => undefined,
			stop: () => undefined,
		},
		source: {
			resolveSource(address) {
				const displayName = registered().find(
					(entry) => key(entry.address) === key(address),
				)?.displayName
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
	}
}

describe('Workbench plugin catalog classification', () => {
	it('has no catalog service or preference file when Workbench is disabled', async () => {
		const host = createRuntimeHost({ workbench: false })
		hosts.push(host)
		expect(() => requireWorkbench(host.ctx)).toThrow('not enabled')
		await expect(
			host.ctx.root.persistence.namespace('workbench').stat('plugin-catalog.json'),
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
			workbench: {
				enabled: true,
				pluginGroups: [
					{
						id: 'chatbots',
						name: 'Chatbots',
						nodes: [pluginNodeAddressOf(FixedChatPlugin)],
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

		await expect(requireWorkbench(host.ctx).pluginCatalog.listGroups()).resolves.toEqual([
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
			workbench: {
				enabled: true,
				pluginGroups: [
					{
						id: 'host',
						name: 'Host',
						nodes: [pluginNodeAddressOf(HostDefaultPlugin)],
					},
				],
			},
		})
		hosts.push(host)
		host.add([HostDefaultPlugin, PackageDefaultPlugin])
		installSourceMap(host, { PackageDefaultPlugin: '@vendor/pkg' })
		await host.commit()

		const catalog = requireWorkbench(host.ctx).pluginCatalog
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

	it('rejects legacy catalog preferences instead of migrating them', async () => {
		const host = createRuntimeHost()
		hosts.push(host)
		await host.ctx.root.persistence
			.namespace('workbench')
			.put(
				'plugin-catalog.json',
				JSON.stringify({ version: 1, assignments: [], groupOrder: [], pluginOrder: [] }),
			)
		const catalog = new WorkbenchPluginCatalogService(host.ctx)
		await expect(catalog.ready).rejects.toThrow('preferences version must be 2')
	})

	it('rejects ambiguous host rules during Workbench installation', () => {
		expect(() =>
			createRuntimeHost({
				workbench: {
					enabled: true,
					pluginGroups: [
						{ id: 'one', name: 'One', packages: ['@vendor/pkg'] },
						{ id: 'two', name: 'Two', packages: ['@vendor/pkg*'] },
					],
				},
			}),
		).toThrow('duplicates a rule')
	})
})
