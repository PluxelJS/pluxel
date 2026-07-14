import { describe, expect, it } from 'vitest'
import { workbench } from '../../src/workbench'
import {
	WorkbenchRegistry,
	type InternalModelRef,
} from '../../src/services/workbench/WorkbenchRegistry'

function fixture(edges: Array<[string, string]> = []) {
	let artifactChanged = () => {}
	const running = new Set<string>()
	const deps = new Map<string, string[]>()
	for (const [consumer, provider] of edges)
		deps.set(consumer, [...(deps.get(consumer) ?? []), provider])
	const ctx: any = {
		root: { effects: { defer: () => ({ dispose() {} }) } },
		registry: {
			graph: { depsOf: (key: string) => deps.get(key) ?? [] },
			resolveRuntimeKey: (id: string) => id,
			isRunning: (id: string) => running.has(id),
			watchInstance: (_id: string, listener: () => void) => {
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
		running,
		artifactChanged: () => artifactChanged(),
	}
}

const rpcRef = (ownerPluginId: string, modelKey: string): InternalModelRef => ({
	ownerPluginId,
	modelKey,
	kind: 'rpc',
})

describe('WorkbenchRegistry', () => {
	it('grants each view only its selected model', () => {
		const { registry, running } = fixture()
		running.add('Owner')
		registry.mount(
			'Owner',
			workbench.define({
				plugin: 'Owner',
				model: {
					commands: workbench.model.rpc<{}>(),
					secrets: workbench.model.rpc<{}>(),
				},
				views: (model) => ({
					Overview: workbench.view.remote({
						model: [model.commands],
						placements: [
							workbench.place.slot({ slot: workbench.slot.PluginInfo }),
							workbench.place.route({
								path: '/overview',
								title: 'Overview',
							}),
						],
					}),
				}),
			}),
			{ commands: rpcRef('Owner', 'commands'), secrets: rpcRef('Owner', 'secrets') },
		)
		const items = registry.getPluginLayout('Owner').items
		expect(items).toHaveLength(2)
		expect(new Set(items.map((item) => item.model.commands!.grantId)).size).toBe(1)
		const item = items[0]!
		expect(Object.keys(item.model)).toEqual(['commands'])
		expect(registry.resolveModel(item.model.commands!.grantId, 'rpc')).toEqual(
			rpcRef('Owner', 'commands'),
		)
	})

	it('projects views only to required dependents', () => {
		const { registry, running } = fixture([['Consumer', 'Provider']])
		running.add('Provider')
		registry.mount(
			'Provider',
			workbench.define({
				plugin: 'Provider',
				views: () => ({
					Capability: workbench.view.remote({
						placements: [
							workbench.place.slot({
								slot: workbench.slot.PluginCapabilities,
								audience: workbench.audience.requiredDependents,
							}),
						],
					}),
				}),
			}),
			{},
		)
		expect(registry.getPluginLayout('Provider').items).toHaveLength(0)
		expect(registry.getPluginLayout('Consumer').items[0]).toMatchObject({
			ownerPluginId: 'Provider',
			targetPluginId: 'Consumer',
		})
	})

	it('keeps grants across bundle updates and revokes them on model graph changes', () => {
		const { registry, running, artifactChanged } = fixture()
		running.add('Owner')
		registry.mount(
			'Owner',
			workbench.define({
				plugin: 'Owner',
				model: { commands: workbench.model.rpc<{}>() },
				views: (model) => ({
					Overview: workbench.view.remote({
						model: [model.commands],
						placements: [workbench.place.slot({ slot: workbench.slot.PluginInfo })],
					}),
				}),
			}),
			{ commands: rpcRef('Owner', 'commands') },
		)
		const grantId = registry.getPluginLayout('Owner').items[0]!.model.commands!.grantId
		artifactChanged()
		expect(registry.getPluginLayout('Owner').items[0]!.model.commands!.grantId).toBe(grantId)
		registry.mount('Other', workbench.define({ plugin: 'Other' }), {})
		expect(registry.findModel(grantId)).toBeNull()
	})
})
