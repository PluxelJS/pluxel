import { describe, expect, it } from 'vitest'
import {
	defineManagementModule,
	defineManagementPort,
	ManagementPlacements,
	managementAudience,
	managementPort,
	managementPortRenderer,
	managementResource,
	managementView,
	remoteView,
} from '../../src/management'
import {
	ManagementRegistry,
	type InternalResourceRef,
} from '../../src/services/management/ManagementRegistry'

function fixture(edges: Array<[string, string]> = []) {
	let artifactChanged = () => {}
	const running = new Set<string>()
	const deps = new Map<string, string[]>()
	for (const [consumer, provider] of edges)
		deps.set(consumer, [...(deps.get(consumer) ?? []), provider])
	const graph = { depsOf: (key: string) => deps.get(key) ?? [] }
	const ctx: any = {
		root: { effects: { defer: () => ({ dispose() {} }) } },
		registry: {
			graph,
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
		getCatalog: () => ({ revision: 0, modules: [], states: [] }),
	}
	return {
		registry: new ManagementRegistry(ctx, artifacts),
		running,
		artifactChanged: () => artifactChanged(),
	}
}

const apiRef = (owner: string, resource: string): InternalResourceRef => ({
	owner,
	resource,
	kind: 'api',
})

describe('ManagementRegistry', () => {
	it('resolves self views and required-dependent projections from the committed graph', () => {
		const { registry, running } = fixture([['Consumer', 'Provider']])
		running.add('Provider')
		registry.mount(
			'Provider',
			defineManagementModule({
				id: 'Provider',
				resources: { api: managementResource.api<{}>() },
				contributions: [
					managementView({
						id: 'capability',
						placement: ManagementPlacements.PluginCapabilities,
						audience: managementAudience.requiredDependents(),
						view: remoteView('Capability'),
					}),
				],
			}),
			{ api: apiRef('Provider', 'api') },
		)

		expect(registry.getPluginLayout('Provider').items).toHaveLength(0)
		expect(registry.getPluginLayout('Consumer').items[0]).toMatchObject({
			owner: 'Provider',
			target: 'Consumer',
			placement: 'plugin.capabilities',
		})
	})

	it('matches a consumer-owned port with a provider renderer and preserves consumer bindings', () => {
		const { registry, running } = fixture()
		running.add('FetchProvider')
		running.add('Consumer')
		const port = defineManagementPort('fetch.settings', {
			settings: managementResource.api<{ read(): unknown }>(),
		})
		registry.mount(
			'FetchProvider',
			defineManagementModule({
				id: 'FetchProvider',
				resources: { presets: managementResource.api<{}>() },
				contributions: [
					managementPortRenderer({ id: 'renderer', port, view: remoteView('FetchSettings') }),
				],
			}),
			{ presets: apiRef('FetchProvider', 'presets') },
		)
		registry.mount(
			'Consumer',
			defineManagementModule({
				id: 'Consumer',
				resources: { fetchConfig: managementResource.api<{}>() },
				contributions: [
					managementPort({
						id: 'fetch',
						placement: ManagementPlacements.PluginTabs,
						port,
						providers: ['FetchProvider'],
						bindings: { settings: 'fetchConfig' },
					}),
				],
			}),
			{ fetchConfig: apiRef('Consumer', 'fetchConfig') },
		)

		const item = registry.getPluginLayout('Consumer').items[0]!
		expect(item.view).toEqual({ kind: 'remote', export: 'FetchSettings' })
		expect(registry.resolveResource(item.resources.settings!.binding, 'api')).toEqual(
			apiRef('Consumer', 'fetchConfig'),
		)
		expect(registry.resolveResource(item.resources.presets!.binding, 'api')).toEqual(
			apiRef('FetchProvider', 'presets'),
		)
	})

	it('reuses grants for artifact updates and revokes them for resource graph changes', () => {
		const { registry, running, artifactChanged } = fixture()
		running.add('Owner')
		registry.mount(
			'Owner',
			defineManagementModule({
				id: 'Owner',
				resources: { api: managementResource.api<{}>() },
				contributions: [
					managementView({
						id: 'self',
						placement: ManagementPlacements.PluginInfo,
						view: remoteView('Info'),
					}),
				],
			}),
			{ api: apiRef('Owner', 'api') },
		)
		const binding = registry.getPluginLayout('Owner').items[0]!.resources.api!.binding
		expect(registry.resolveResource(binding)).toEqual(apiRef('Owner', 'api'))
		artifactChanged()
		expect(registry.getPluginLayout('Owner').items[0]!.resources.api!.binding).toBe(binding)
		expect(registry.resolveResource(binding)).toEqual(apiRef('Owner', 'api'))
		registry.mount('Other', defineManagementModule({ id: 'Other' }), {})
		expect(registry.findResource(binding)).toBeNull()
		expect(() => registry.resolveResource(binding)).toThrow(/invalid or expired/)
	})

	it('does not publish requireRunning contributions until the owner is running', () => {
		const { registry, running } = fixture()
		registry.mount(
			'Owner',
			defineManagementModule({
				id: 'Owner',
				contributions: [
					managementView({
						id: 'self',
						placement: ManagementPlacements.PluginInfo,
						view: remoteView('Info'),
					}),
				],
			}),
			{},
		)
		expect(registry.getPluginLayout('Owner').items).toHaveLength(0)
		running.add('Owner')
		expect(registry.getPluginLayout('Owner').items).toHaveLength(1)
	})
})
