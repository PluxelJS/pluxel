import { pluginNodeAddressOf, type PluginNodeAddress } from '@pluxel/core'
import { PluginSlotRegistry, requirePluginService } from '@pluxel/core/internal'
import { BasePlugin, Plugin, withCoreHost } from '@pluxel/core/test'
import { describe, expect, it, vi } from 'vitest'
import { lowerTestReplacement } from './lowered-replacement'

@Plugin({ forkable: true })
class QueryTarget extends BasePlugin {}

@Plugin()
class PendingDraftMarker extends BasePlugin {}

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
