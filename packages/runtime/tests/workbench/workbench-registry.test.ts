import { describe, expect, it } from 'vitest'
import { workbench } from '../../src/workbench'
import { workbenchContract } from '../../src/workbench-contract'
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
	it('grants every owner resource to each owner View', () => {
		const { registry, running } = fixture()
		running.add('Owner')
		registry.mount(
			'Owner',
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
			{ commands: rpcRef('Owner', 'commands'), secrets: rpcRef('Owner', 'secrets') },
		)
		const items = registry.getPluginLayout('Owner').items
		expect(items).toHaveLength(2)
		expect(new Set(items.map((item) => item.model.commands!.grantId)).size).toBe(1)
		const item = items[0]!
		expect(Object.keys(item.model)).toEqual(['commands', 'secrets'])
		expect(registry.resolveModel(item.model.commands!.grantId, 'rpc')).toEqual(
			rpcRef('Owner', 'commands'),
		)
	})

	it('keeps grants across bundle and unrelated plugin updates, then revokes the owner lease', () => {
		const { registry, running, artifactChanged } = fixture()
		running.add('Owner')
		const disposeOwner = registry.mount(
			'Owner',
			workbench.extension({
				contract: workbenchContract.define({
					resources: { commands: workbenchContract.rpc<{}>() },
					views: {
						Overview: {
							placements: [workbenchContract.tab()],
						},
					},
				}),
			}),
			{ commands: rpcRef('Owner', 'commands') },
		)
		const grantId = registry.getPluginLayout('Owner').items[0]!.model.commands!.grantId
		artifactChanged()
		expect(registry.getPluginLayout('Owner').items[0]!.model.commands!.grantId).toBe(grantId)
		registry.mount('Other', workbench.extension({ contract: workbenchContract.define({}) }), {})
		expect(registry.findModel(grantId)).toEqual(rpcRef('Owner', 'commands'))
		disposeOwner()
		expect(registry.findModel(grantId)).toBeNull()
	})

	it('renders a required dependency through a target-scoped Port grant', () => {
		const { registry, running } = fixture([['Consumer', 'Provider']])
		running.add('Consumer')
		running.add('Provider')
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
		registry.mount('Consumer', workbench.extension({ contract: ConsumerUi }), {
			commands: rpcRef('Consumer', 'commands'),
		})
		expect(registry.getPluginLayout('Consumer').items[0]?.view).toMatchObject({
			kind: 'builtin',
			renderer: 'document',
		})
		registry.mount('Provider', workbench.extension({ contract: ProviderUi }), {
			status: rpcRef('Provider', 'status'),
		})

		const item = registry.getPluginLayout('Consumer').items[0]!
		expect(item).toMatchObject({
			ownerPluginId: 'Provider',
			targetPluginId: 'Consumer',
			viewId: 'Settings',
			port: { id: 'test.settings', version: 1 },
		})
		expect(registry.resolveModel(item.model.status!.grantId)).toEqual(rpcRef('Provider', 'status'))
		expect(registry.resolveModel(item.port!.model.settings!.grantId)).toEqual(
			rpcRef('Consumer', 'commands'),
		)
	})
})
