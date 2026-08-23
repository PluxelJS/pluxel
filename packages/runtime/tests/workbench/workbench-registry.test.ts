import { pluginNodeAddressOf, type PluginNodeAddress, type PluginNodeSlot } from '@pluxel/core'
import { requirePluginService } from '@pluxel/core/internal'
import { BasePlugin, createRuntimeHost, Plugin, type RuntimeHost } from '@pluxel/runtime/test'
import { describe, expect, it } from 'vitest'
import { workbench } from '../../src/workbench'
import { workbenchContract } from '../../src/workbench-contract'
import {
	WorkbenchRegistry,
	type InternalModelRef,
} from '../../src/services/workbench/WorkbenchRegistry'

@Plugin({ displayName: 'Owner' })
class OwnerPlugin extends BasePlugin {}

@Plugin({ displayName: 'Other' })
class OtherPlugin extends BasePlugin {}

@Plugin({ displayName: 'Provider' })
class ProviderPlugin extends BasePlugin {}

@Plugin({ displayName: 'Consumer' })
class ConsumerPlugin extends BasePlugin {
	constructor(readonly provider: ProviderPlugin) {
		super()
	}
}

const TEST_PLUGINS = {
	Owner: OwnerPlugin,
	Other: OtherPlugin,
	Provider: ProviderPlugin,
	Consumer: ConsumerPlugin,
} as const

type TestNodeName = keyof typeof TEST_PLUGINS

type TestNode = Readonly<{
	address: PluginNodeAddress
	slot: PluginNodeSlot
	descriptor: {
		address: PluginNodeAddress
		displayName: string
		rootExportName: string
	}
}>

async function fixture(): Promise<{
	registry: WorkbenchRegistry
	node: (displayName: TestNodeName) => TestNode
	artifactChanged: () => void
	host: RuntimeHost
}> {
	let artifactChanged = () => {}
	const host = createRuntimeHost({ workbench: false })
	for (const PluginCtor of Object.values(TEST_PLUGINS)) {
		host.add(PluginCtor)
		host.cfg(PluginCtor).enable()
	}
	await host.commit()
	const pluginService = requirePluginService(host.ctx)
	const nodes = new Map<TestNodeName, TestNode>()
	const node = (displayName: TestNodeName): TestNode => {
		const existing = nodes.get(displayName)
		if (existing) return existing
		const address = pluginNodeAddressOf(TEST_PLUGINS[displayName])
		const slot = pluginService.resolvePluginNode(address)
		if (!slot) throw new Error(`Missing running test Plugin node: ${displayName}`)
		const result = {
			address,
			slot,
			descriptor: { address, displayName, rootExportName: address.definition.exportName },
		}
		nodes.set(displayName, result)
		return result
	}
	const artifacts: any = {
		subscribe: (listener: () => void) => {
			artifactChanged = listener
			return () => {}
		},
		getCatalog: () => ({ revision: 0, bundles: [], states: [] }),
	}
	return {
		registry: new WorkbenchRegistry(host.ctx, artifacts),
		node,
		artifactChanged: () => artifactChanged(),
		host,
	}
}

const rpcRef = (ownerSlot: PluginNodeSlot, modelKey: string): InternalModelRef => ({
	ownerSlot,
	resourceId: `resource:${modelKey}`,
	modelKey,
	kind: 'rpc',
})

describe('WorkbenchRegistry', () => {
	it('grants every owner resource to each owner View', async () => {
		const { registry, node, host } = await fixture()
		const owner = node('Owner')
		try {
			registry.mount(
				owner.slot,
				owner.descriptor,
				workbench.extension({
					contract: workbenchContract.define({
						resources: {
							commands: workbenchContract.rpc<{}>(),
							secrets: workbenchContract.rpc<{}>(),
						},
						views: {
							Overview: {
								placements: [
									workbenchContract.tab(),
									workbenchContract.route('/overview', { title: 'Overview' }),
								],
							},
						},
					}),
				}),
				{ commands: rpcRef(owner.slot, 'commands'), secrets: rpcRef(owner.slot, 'secrets') },
			)
			const items = registry.getPluginLayout(owner.address).items
			expect(items).toHaveLength(2)
			expect(new Set(items.map((item) => item.model.commands!.grantId)).size).toBe(1)
			const item = items[0]!
			expect(Object.keys(item.model)).toEqual(['commands', 'secrets'])
			expect(registry.resolveModel(item.model.commands!.grantId, 'rpc')).toEqual(
				rpcRef(owner.slot, 'commands'),
			)
		} finally {
			await host.dispose()
		}
	})

	it('keeps grants across bundle and unrelated plugin updates, then revokes the owner lease', async () => {
		const { registry, node, artifactChanged, host } = await fixture()
		const owner = node('Owner')
		try {
			const disposeOwner = registry.mount(
				owner.slot,
				owner.descriptor,
				workbench.extension({
					contract: workbenchContract.define({
						resources: { commands: workbenchContract.rpc<{}>() },
						views: { Overview: { placements: [workbenchContract.tab()] } },
					}),
				}),
				{ commands: rpcRef(owner.slot, 'commands') },
			)
			const grantId = registry.getPluginLayout(owner.address).items[0]!.model.commands!.grantId
			artifactChanged()
			expect(registry.getPluginLayout(owner.address).items[0]!.model.commands!.grantId).toBe(
				grantId,
			)
			const other = node('Other')
			registry.mount(
				other.slot,
				other.descriptor,
				workbench.extension({ contract: workbenchContract.define({}) }),
				{},
			)
			expect(registry.findModel(grantId)).toEqual(rpcRef(owner.slot, 'commands'))
			disposeOwner()
			expect(registry.findModel(grantId)).toBeNull()
		} finally {
			await host.dispose()
		}
	})

	it('renders a required dependency through a target-scoped Port grant', async () => {
		const { registry, node, host } = await fixture()
		const consumer = node('Consumer')
		const provider = node('Provider')
		try {
			const SettingsPort = workbenchContract.port({
				id: 'test.settings',
				version: 1,
				resources: { settings: workbenchContract.rpc<{}>() },
			})
			const ConsumerUi = workbenchContract.define({
				resources: { commands: workbenchContract.rpc<{}>() },
				views: {},
				outlets: ({ resources }) => ({
					Settings: {
						port: SettingsPort,
						placement: workbenchContract.tab(),
						provide: { settings: resources.commands },
					},
				}),
			})
			const ProviderUi = workbenchContract.define({
				resources: { status: workbenchContract.rpc<{}>() },
				views: { Settings: { accepts: SettingsPort } },
			})
			registry.mount(
				consumer.slot,
				consumer.descriptor,
				workbench.extension({ contract: ConsumerUi }),
				{ commands: rpcRef(consumer.slot, 'commands') },
			)
			expect(registry.getPluginLayout(consumer.address).items[0]?.view).toMatchObject({
				kind: 'builtin',
				renderer: 'document',
			})
			registry.mount(
				provider.slot,
				provider.descriptor,
				workbench.extension({ contract: ProviderUi }),
				{ status: rpcRef(provider.slot, 'status') },
			)

			const item = registry.getPluginLayout(consumer.address).items[0]!
			expect(item).toMatchObject({
				owner: provider.descriptor,
				target: consumer.descriptor,
				viewId: 'Settings',
				port: { id: 'test.settings', version: 1 },
			})
			expect(registry.resolveModel(item.model.status!.grantId)).toEqual(
				rpcRef(provider.slot, 'status'),
			)
			expect(registry.resolveModel(item.port!.model.settings!.grantId)).toEqual(
				rpcRef(consumer.slot, 'commands'),
			)
		} finally {
			await host.dispose()
		}
	})
})
