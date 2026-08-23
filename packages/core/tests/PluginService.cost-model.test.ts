import {
	createContextHost,
	installRootCapability,
	pluginNodeAddressOf,
	type PluginNodeAddress,
	type RootContext,
} from '@pluxel/core'
import {
	CONFIG_SERVICE_CAPABILITY,
	consumePluginDefinitionCandidate,
	createCoreContextInstallations,
	PluginSlotRegistry,
	requirePluginService,
	resolveCoreRootInputs,
} from '@pluxel/core/internal'
import { BasePlugin, Plugin, withCoreHost } from '@pluxel/core/test'
import { describe, expect, it, vi } from 'vitest'
import { lowerTestReplacement } from './lowered-replacement'

@Plugin({ forkable: true })
class QueryTarget extends BasePlugin {}

@Plugin()
class PendingDraftMarker extends BasePlugin {}

@Plugin()
class ConfiglessTeardown extends BasePlugin {}

function slotsOf(registry: object): PluginSlotRegistry {
	return (
		registry as unknown as {
			definitions: { slots: PluginSlotRegistry }
		}
	).definitions.slots
}

function definitionInternalsOf(registry: object) {
	return (
		registry as unknown as {
			definitions: {
				createPluginContext: () => unknown
				definitions: Map<unknown, unknown>
				nodes: Map<unknown, unknown>
				pendingDefinitions: Map<unknown, unknown>
				pendingNodes: Map<unknown, unknown>
				lastGraph: { slotCount(): number; activeCount(): number }
			}
		}
	).definitions
}

describe('PluginService read cost model', () => {
	it('keeps ConfigService lazy across configless lifecycle and teardown', async () => {
		const inputs = resolveCoreRootInputs({ name: 'configless-cost-model' })
		let configServiceCreations = 0
		const host = createContextHost({
			name: 'configless-cost-model',
			capabilities: createCoreContextInstallations(inputs),
			overrides: [
				installRootCapability(CONFIG_SERVICE_CAPABILITY, {
					create: () => {
						configServiceCreations += 1
						throw new Error('ConfigService must remain lazy for configless Plugins')
					},
				}),
			],
		})
		const root = host.createRoot(inputs.name) as RootContext
		try {
			const plugins = requirePluginService(root)
			const address = pluginNodeAddressOf(ConfiglessTeardown)
			const candidate = consumePluginDefinitionCandidate(ConfiglessTeardown)
			const add = plugins.beginUpdate({ reason: 'configless-cost-model-add' })
			add.materializeNode(address, candidate)
			const added = await add.commit()
			expect(added.ok).toBe(true)

			const remove = plugins.beginUpdate({ reason: 'configless-cost-model-remove' })
			remove.dematerializeNode(address)
			const removed = await remove.commit()
			expect(removed.ok).toBe(true)
			expect(configServiceCreations).toBe(0)
		} finally {
			await root.effects.dispose()
		}
	})

	it.each(['committed', 'pending'] as const)(
		'replaces a definition family through one %s multi-root closure traversal',
		async (mode) => {
			await withCoreHost(async (host) => {
				host.add(QueryTarget)
				host.cfg(QueryTarget).enable()
				const forks = Array.from({ length: 32 }, (_, index) =>
					host.fork(QueryTarget, `cost-${index}`),
				)
				for (const fork of forks) host.cfg(fork).enable()
				await host.commit()

				class QueryTargetReplacement extends BasePlugin {}
				lowerTestReplacement(QueryTarget, QueryTargetReplacement, {
					plugin: { forkable: true },
				})
				const registry = requirePluginService(host.ctx) as unknown as {
					dependentClosure: {
						collect: (graph: unknown, roots: Iterable<unknown>) => Set<unknown>
					}
					definitions: {
						collectPlanningCascadeTargets: (roots: Iterable<unknown>) => Set<unknown>
					}
				}
				if (mode === 'pending') host.add(PendingDraftMarker)
				let collectCalls: unknown[][]
				if (mode === 'committed') {
					const collect = vi.spyOn(registry.dependentClosure, 'collect')
					host.replace(QueryTarget, QueryTargetReplacement)
					collectCalls = collect.mock.calls.map(([, roots]) => Array.from(roots))
				} else {
					const collect = vi.spyOn(registry.definitions, 'collectPlanningCascadeTargets')
					host.replace(QueryTarget, QueryTargetReplacement)
					collectCalls = collect.mock.calls.map(([roots]) => Array.from(roots))
				}
				expect(collectCalls).toHaveLength(1)
				expect(collectCalls[0]).toHaveLength(33)
			})
		},
	)

	it('unions every provider-default consumer into one closure traversal', async () => {
		await withCoreHost(async (host) => {
			const plugins = requirePluginService(host.ctx)
			host.add(QueryTarget)
			const first = host.fork(QueryTarget, 'provider-default-consumer-1')
			const second = host.fork(QueryTarget, 'provider-default-consumer-2')
			await host.commit()
			const consumers = [plugins.resolvePluginNode(first)!, plugins.resolvePluginNode(second)!]
			let collectedRoots: unknown[] = []
			const internals = plugins as unknown as {
				definitions: {
					setProviderDefault: (token: unknown, provider: unknown) => void
				}
				currentPlanningGraph: () => { consumers: (token: unknown) => unknown[] }
				collectPlanningCascadeTargets: (
					roots: Iterable<unknown>,
					cascadeDependents: boolean,
				) => Set<unknown>
				setProviderDefault: (token: unknown, provider: unknown) => void
			}
			vi.spyOn(internals, 'currentPlanningGraph').mockReturnValue({
				consumers: () => consumers,
			})
			vi.spyOn(internals.definitions, 'setProviderDefault').mockImplementation(() => undefined)
			const collect = vi
				.spyOn(internals, 'collectPlanningCascadeTargets')
				.mockImplementation((roots) => {
					collectedRoots = Array.from(roots)
					return new Set()
				})

			internals.setProviderDefault(pluginNodeAddressOf(QueryTarget).definition, null)

			expect(collect).toHaveBeenCalledOnce()
			expect(collect.mock.calls[0]![1]).toBe(true)
			expect(collectedRoots).toEqual(consumers)
		})
	})

	it('does not create slots, records, or generations for disabled and orphan projections', async () => {
		await withCoreHost(async (host) => {
			const registry = requirePluginService(host.ctx)
			const orphan = Object.freeze({
				definition: pluginNodeAddressOf(QueryTarget).definition,
				variant: 'fork' as const,
				forkId: 'disabled-orphan',
			}) satisfies PluginNodeAddress
			const definitions = definitionInternalsOf(registry)
			const createPluginContext = definitions.createPluginContext
			let generationContexts = 0
			definitions.createPluginContext = () => {
				generationContexts += 1
				return createPluginContext()
			}

			host.cfg(QueryTarget).disable()
			expect(host.cfg(QueryTarget).enabled()).toBe(false)
			expect(registry.isMaterialized(orphan)).toBe(false)
			expect(registry.isRunning(orphan)).toBe(false)
			expect(registry.getInstance(orphan)).toBeUndefined()
			expect(registry.resolvedDependencies(orphan)).toEqual([])
			expect(registry.resolvePluginNode(orphan)).toBeUndefined()
			const unwatch = registry.watchInstance(orphan, () => {})
			unwatch()

			expect(generationContexts).toBe(0)
			expect(definitions.definitions).toHaveLength(0)
			expect(definitions.nodes).toHaveLength(0)
			expect(definitions.pendingDefinitions).toHaveLength(0)
			expect(definitions.pendingNodes).toHaveLength(0)
			expect(definitions.lastGraph.slotCount()).toBe(0)
			expect(definitions.lastGraph.activeCount()).toBe(0)
			expect(slotsOf(registry).lookupDefinition(orphan.definition)).toBeUndefined()
			expect(slotsOf(registry).lookupNode(orphan)).toBeUndefined()
		})
	})

	it('does not intern absent nodes through reads or rejected planning mutations', async () => {
		await withCoreHost(async (host) => {
			const registry = requirePluginService(host.ctx)
			const defaultAddress = pluginNodeAddressOf(QueryTarget)
			const orphan = Object.freeze({
				definition: defaultAddress.definition,
				variant: 'fork' as const,
				forkId: 'orphan',
			}) satisfies PluginNodeAddress
			const slots = slotsOf(registry)
			const addressWatcher = vi.fn()
			const constructorWatcher = vi.fn()

			expect(registry.isMaterialized(orphan)).toBe(false)
			expect(registry.isRunning(orphan)).toBe(false)
			expect(registry.getInstance(orphan)).toBeUndefined()
			expect(registry.resolvedDependencies(orphan)).toEqual([])
			expect(registry.resolvePluginNode(orphan)).toBeUndefined()
			expect(registry.isRunning(QueryTarget)).toBe(false)
			expect(registry.getInstance(QueryTarget)).toBeUndefined()
			expect(registry.resolvePluginNode(QueryTarget)).toBeUndefined()
			const unwatchAddress = registry.watchInstance(orphan, addressWatcher)
			const unwatchConstructor = registry.watchInstance(QueryTarget, constructorWatcher)

			host.remove(orphan)
			expect(() => host.restart(orphan)).toThrow(/absent Plugin node/)
			expect(() => host.override(orphan, QueryTarget, null)).toThrow(/consumer is absent/)
			expect(slots.lookupDefinition(orphan.definition)).toBeUndefined()
			expect(slots.lookupNode(orphan)).toBeUndefined()
			expect(addressWatcher).toHaveBeenCalledOnce()
			expect(addressWatcher).toHaveBeenLastCalledWith(undefined)
			expect(constructorWatcher).toHaveBeenCalledOnce()
			expect(constructorWatcher).toHaveBeenLastCalledWith(undefined)

			const materialized = host.fork(QueryTarget, 'orphan')
			await host.commit()
			expect(slots.lookupNode(orphan)).toBe(registry.resolvePluginNode(materialized))
			expect(addressWatcher).toHaveBeenLastCalledWith(host.require(materialized))
			expect(constructorWatcher).toHaveBeenCalledOnce()
			expect(constructorWatcher).toHaveBeenLastCalledWith(undefined)

			unwatchAddress()
			unwatchConstructor()
		})
	})
})
