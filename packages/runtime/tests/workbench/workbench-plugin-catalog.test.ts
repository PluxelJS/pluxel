import { afterEach, describe, expect, it } from 'vitest'
import {
	BasePlugin,
	createRuntimeHost,
	getPluginInfo,
	Plugin,
	type RuntimeHost,
} from '@pluxel/runtime/test'
import type { RuntimePluginSource } from '../../src/runtime/capabilities'
import { requireWorkbench } from '../../src/services/workbench'

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
	const registered = () =>
		new Map(host.plugins().map((ctor) => [getPluginInfo(ctor).id, ctor] as const))
	host.ctx.runtimeRoute = {
		catalog: {
			resolve(target) {
				return typeof target === 'string' ? registered().get(target) : target
			},
			resolveOrRegistered: (name) => registered().get(name),
			require(name) {
				const ctor = registered().get(name)
				if (!ctor) throw new Error(`missing test plugin: ${name}`)
				return ctor
			},
			listRegistered: registered,
			listLoadedNames: () => [...registered().keys()],
		},
		lifecycle: {
			isRunning(target) {
				const ctor = typeof target === 'string' ? registered().get(target) : target
				return ctor ? host.isRunning(ctor) : false
			},
			enable: () => undefined,
			enablePersisted: () => undefined,
			deactivate: () => undefined,
			stop: () => undefined,
		},
		source: {
			resolveSource(name) {
				const packageName = packages[name]
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
		@Plugin({ name: 'FixedChatPlugin' })
		class FixedChatPlugin extends BasePlugin {}
		@Plugin({ name: 'SuitePackagePlugin' })
		class SuitePackagePlugin extends BasePlugin {}
		@Plugin({ name: 'VendorPluginA' })
		class VendorPluginA extends BasePlugin {}
		@Plugin({ name: 'VendorPluginB' })
		class VendorPluginB extends BasePlugin {}

		const host = createRuntimeHost({
			workbench: {
				enabled: true,
				pluginGroups: [
					{
						id: 'chatbots',
						name: 'Chatbots',
						plugins: ['FixedChatPlugin'],
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
				pluginIds: ['FixedChatPlugin', 'SuitePackagePlugin'],
			},
			{
				groupId: 'package:@vendor/tools',
				name: '@vendor/tools',
				pluginIds: ['VendorPluginA', 'VendorPluginB'],
			},
		])
	})

	it('stores user moves as overrides while keeping the group registry closed', async () => {
		@Plugin({ name: 'HostDefaultPlugin' })
		class HostDefaultPlugin extends BasePlugin {}
		@Plugin({ name: 'PackageDefaultPlugin' })
		class PackageDefaultPlugin extends BasePlugin {}

		const host = createRuntimeHost({
			workbench: {
				enabled: true,
				pluginGroups: [
					{
						id: 'host',
						name: 'Host',
						plugins: ['HostDefaultPlugin'],
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
				{ groupId: 'host', name: 'Host', pluginIds: ['PackageDefaultPlugin'] },
				{ groupId: 'package:@vendor/pkg', name: '@vendor/pkg', pluginIds: [] },
			]),
		).resolves.toEqual([
			{ groupId: 'host', name: 'Host', pluginIds: ['PackageDefaultPlugin'] },
			{ groupId: 'package:@vendor/pkg', name: '@vendor/pkg', pluginIds: [] },
		])

		await expect(
			catalog.updateGroups([
				{ groupId: 'invented', name: 'Invented', pluginIds: ['HostDefaultPlugin'] },
			]),
		).rejects.toMatchObject({ code: 'INVALID_PLUGIN_GROUP_LAYOUT' })
		await expect(
			catalog.updateGroups([
				{ groupId: 'host', name: 'Renamed', pluginIds: ['HostDefaultPlugin'] },
			]),
		).rejects.toMatchObject({ code: 'INVALID_PLUGIN_GROUP_LAYOUT' })
	})

	it('migrates only legacy memberships registered by the host', async () => {
		@Plugin({ name: 'MigratedPlugin' })
		class MigratedPlugin extends BasePlugin {}
		@Plugin({ name: 'DiscardedPlugin' })
		class DiscardedPlugin extends BasePlugin {}

		const host = createRuntimeHost({
			runtimeState: {
				mode: 'memory',
				snapshot: {
					enabled: [],
					pluginGroups: [
						{ groupId: 'allowed', name: 'Old allowed', pluginIds: ['MigratedPlugin'] },
						{ groupId: 'custom', name: 'Old custom', pluginIds: ['DiscardedPlugin'] },
					],
				},
			},
			workbench: {
				enabled: true,
				pluginGroups: [{ id: 'allowed', name: 'Allowed' }],
			},
		})
		hosts.push(host)
		host.add([MigratedPlugin, DiscardedPlugin])
		installSourceMap(host, {})
		await host.commit()

		await expect(requireWorkbench(host.ctx).pluginCatalog.listGroups()).resolves.toEqual([
			{ groupId: 'allowed', name: 'Allowed', pluginIds: ['MigratedPlugin'] },
		])
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
