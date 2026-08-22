import { PluginSlotRegistry, type PluginNodeAddress, type PluginNodeSlot } from '@pluxel/core'
import { describe, expect, it } from 'vitest'
import { workbench } from '../../src/workbench'
import { workbenchContract } from '../../src/workbench-contract'
import {
	WorkbenchRegistry,
	type InternalModelRef,
} from '../../src/services/workbench/WorkbenchRegistry'

type TestNode = Readonly<{
	address: PluginNodeAddress
	slot: PluginNodeSlot
	descriptor: {
		address: PluginNodeAddress
		displayName: string
		rootExportName: string
	}
}>

function fixture(edges: Array<[string, string]> = []) {
	let artifactChanged = () => {}
	const slots = new PluginSlotRegistry()
	const nodes = new Map<string, TestNode>()
	const node = (displayName: string): TestNode => {
		const existing = nodes.get(displayName)
		if (existing) return existing
		const address: PluginNodeAddress = {
			definition: {
				entry: { kind: 'source-entry', sourceSpace: 'app', path: `pluxel-test:${displayName}` },
				exportName: 'Plugin',
			},
			variant: 'default',
		}
		const result = {
			address,
			slot: slots.internNode(address),
			descriptor: { address, displayName, rootExportName: 'Plugin' },
		}
		nodes.set(displayName, result)
		return result
	}
	const running = new Set<PluginNodeSlot>()
	const deps = new Map<PluginNodeSlot, PluginNodeSlot[]>()
	for (const [consumerName, providerName] of edges) {
		const consumer = node(consumerName).slot
		const provider = node(providerName).slot
		deps.set(consumer, [...(deps.get(consumer) ?? []), provider])
	}
	const ctx: any = {
		root: { effects: { defer: () => ({ dispose() {} }) } },
		registry: {
			graph: { depsOf: (slot: PluginNodeSlot) => deps.get(slot) ?? [] },
			internNodeAddress: (address: PluginNodeAddress) => slots.internNode(address),
			nodeAddressOf: (slot: PluginNodeSlot) => slots.nodeAddress(slot),
			isRunning: (slot: PluginNodeSlot) => running.has(slot),
			watchInstance: (_slot: PluginNodeSlot, listener: () => void) => {
				listener()
				return () => {}
			},
		},
	}
	const artifacts: any = {
		subscribe: (listener: () => void) => {
			artifactChanged = listener
			return () => {}
		},
		getCatalog: () => ({ revision: 0, bundles: [], states: [] }),
	}
	return {
		registry: new WorkbenchRegistry(ctx, artifacts),
		node,
		running,
		artifactChanged: () => artifactChanged(),
	}
}

const rpcRef = (ownerSlot: PluginNodeSlot, modelKey: string): InternalModelRef => ({
	ownerSlot,
	resourceId: `resource:${modelKey}`,
	modelKey,
	kind: 'rpc',
})

describe('WorkbenchRegistry', () => {
	it('grants every owner resource to each owner View', () => {
		const { registry, node, running } = fixture()
		const owner = node('Owner')
		running.add(owner.slot)
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
	})

	it('keeps grants across bundle and unrelated plugin updates, then revokes the owner lease', () => {
		const { registry, node, running, artifactChanged } = fixture()
		const owner = node('Owner')
		running.add(owner.slot)
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
		expect(registry.getPluginLayout(owner.address).items[0]!.model.commands!.grantId).toBe(grantId)
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
	})

	it('renders a required dependency through a target-scoped Port grant', () => {
		const { registry, node, running } = fixture([['Consumer', 'Provider']])
		const consumer = node('Consumer')
		const provider = node('Provider')
		running.add(consumer.slot)
		running.add(provider.slot)
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
	})
})
