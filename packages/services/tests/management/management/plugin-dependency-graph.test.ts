import {
	createPluginCatalogSnapshot,
	emptyAppliedPluginGraphSnapshot,
	requireHostStateStore,
} from '@pluxel/host/internal'
import {
	pluginDefinitionAddressOf,
	pluginDefinitionIndexKey,
	pluginNodeAddressOf,
	pluginNodeIndexKey,
	type PluginDefinitionAddress,
	type PluginNodeAddress,
} from '@pluxel/core'
import { requirePluginService, type ConcretePluginDefinitionCandidate } from '@pluxel/core/internal'
import { createServiceInternalTestHarness } from '@pluxel/services/internal/test'
import { BasePlugin, Plugin } from '@pluxel/core/internal/test'
import { describe, expect, it, vi } from 'vitest'
import { RuntimeManagementTargetImpl } from '../../../src/management/services/management/RuntimeManagementTarget.ts'
import { projectPluginDependencyGraph } from '../../../src/management/api/usecases/pluginDependencyGraph.ts'
import { parsePluginDependencyGraphSnapshot } from '../../../src/management/web/management-validation.ts'

@Plugin()
class DirectProvider extends BasePlugin {}
@Plugin({ forkable: true })
class DirectConsumer extends BasePlugin {
	constructor(readonly provider: DirectProvider) {
		super()
	}
}

@Plugin()
class FailingProvider extends BasePlugin {
	override init(): void {
		throw new Error('expected graph fixture start failure')
	}
}
@Plugin()
class BlockedConsumer extends BasePlugin {
	constructor(readonly provider: FailingProvider) {
		super()
	}
}

abstract class CycleToken extends BasePlugin {}
@Plugin()
class CycleConsumer extends BasePlugin {
	constructor(readonly provider: CycleToken) {
		super()
	}
}
@Plugin(CycleToken)
class CycleProvider extends CycleToken {
	constructor(readonly consumer: CycleConsumer) {
		super()
	}
}
@Plugin(CycleToken)
class SafeProvider extends CycleToken {}

describe('Plugin dependency graph read model', () => {
	it('projects direct, inactive-fork, effective, and zero-intern facts', async () => {
		await using host = await createServiceInternalTestHarness({ workbench: false })

		const DirectProviderDefinition = pluginDefinitionAddressOf(DirectProvider)
		host.add([DirectProvider, DirectConsumer])
		const inactiveFork = host.fork(DirectConsumer, 'inactive')
		host.cfg(DirectProvider).setAutoStart(true)
		host.start(DirectProvider)
		host.cfg(DirectConsumer).setAutoStart(true)
		host.start(DirectConsumer)
		await host.commit()

		const registry = requirePluginService(host.ctx)
		const internNode = vi.spyOn(registry, 'internNodeAddress')
		const internDefinition = vi.spyOn(registry, 'internDefinitionAddress')
		const graph = await new RuntimeManagementTargetImpl(host.ctx).pluginDependencyGraphDto()
		expect(() => parsePluginDependencyGraphSnapshot(graph)).not.toThrow()
		expect(internNode).not.toHaveBeenCalled()
		expect(internDefinition).not.toHaveBeenCalled()

		const effective = new Map(
			graph.nodes.map((entry) => [pluginNodeIndexKey(entry.status.address), entry.effective]),
		)
		expect(effective.get(pluginNodeIndexKey(pluginNodeAddressOf(DirectProvider)))).toBe(true)
		expect(effective.get(pluginNodeIndexKey(pluginNodeAddressOf(DirectConsumer)))).toBe(true)
		expect(effective.get(pluginNodeIndexKey(inactiveFork))).toBe(false)

		const directDefault = graph.edges.find(
			(edge) =>
				pluginNodeIndexKey(edge.consumer) ===
					pluginNodeIndexKey(pluginNodeAddressOf(DirectConsumer)) &&
				pluginDefinitionIndexKey(edge.requirement) ===
					pluginDefinitionIndexKey(DirectProviderDefinition),
		)
		expect(directDefault).toMatchObject({
			mode: 'required',
			resolution: { state: 'resolved', via: 'direct' },
			effective: true,
		})
		expect(
			graph.edges.filter(
				(edge) =>
					pluginNodeIndexKey(edge.consumer) ===
						pluginNodeIndexKey(pluginNodeAddressOf(DirectConsumer)) &&
					pluginDefinitionIndexKey(edge.requirement) ===
						pluginDefinitionIndexKey(DirectProviderDefinition),
			),
		).toHaveLength(1)
		expect(
			graph.edges.find(
				(edge) =>
					pluginNodeIndexKey(edge.consumer) === pluginNodeIndexKey(inactiveFork) &&
					pluginDefinitionIndexKey(edge.requirement) ===
						pluginDefinitionIndexKey(DirectProviderDefinition),
			),
		).toMatchObject({ mode: 'required', effective: false })
	})

	it('keeps stopped lifecycle status separate from committed graph membership', async () => {
		await using host = await createServiceInternalTestHarness({ workbench: false })

		host.add([FailingProvider, BlockedConsumer])
		host.cfg(FailingProvider).setAutoStart(true)
		host.start(FailingProvider)
		host.cfg(BlockedConsumer).setAutoStart(true)
		host.start(BlockedConsumer)
		await host.commitAllowFail()
		const graph = await new RuntimeManagementTargetImpl(host.ctx).pluginDependencyGraphDto()
		expect(() => parsePluginDependencyGraphSnapshot(graph)).not.toThrow()
		const provider = graph.nodes.find(
			(node) =>
				pluginNodeIndexKey(node.status.address) ===
				pluginNodeIndexKey(pluginNodeAddressOf(FailingProvider)),
		)
		expect(provider).toMatchObject({
			effective: true,
			status: {
				desiredState: 'running',
				activationReason: 'auto-start',
				lifecycleState: 'stopped',
			},
		})
		expect(graph.edges).toEqual([expect.objectContaining({ mode: 'required', effective: true })])
	})

	it('uses the fixed resolution table and expands only eligible declarations', async () => {
		await using host = await createServiceInternalTestHarness({ workbench: false })

		const Direct = graphDefinition('Direct')
		const AbstractDefault = graphDefinition('AbstractDefault')
		const Override = graphDefinition('Override')
		const InvalidOverride = graphDefinition('InvalidOverride')
		const Unresolved = graphDefinition('Unresolved')
		const OptionalPresent = graphDefinition('OptionalPresent')
		const OptionalAbsent = graphDefinition('OptionalAbsent')
		const Provider = graphDefinition('Provider')
		const AbsentProvider = graphDefinition('AbsentProvider')
		const Consumer = graphDefinition('Consumer')
		const InvalidForkConsumer = graphDefinition('InvalidForkConsumer')
		const Orphan = graphDefinition('Orphan')
		const consumer = graphNode(Consumer)
		const consumerFork = graphNode(Consumer, 'cold')
		const invalidFork = graphNode(InvalidForkConsumer, 'invalid')
		const provider = graphNode(Provider)
		const absentProvider = graphNode(AbsentProvider)
		const orphan = graphNode(Orphan)
		const state = Object.freeze({
			autoStart: Object.freeze([orphan]),
			forks: Object.freeze([
				Object.freeze({ definition: Consumer, forkIds: Object.freeze(['cold']) }),
				Object.freeze({
					definition: InvalidForkConsumer,
					forkIds: Object.freeze(['invalid']),
				}),
			]),
			providerDefaults: Object.freeze([Object.freeze({ token: AbstractDefault, provider })]),
			dependencyOverrides: Object.freeze([
				Object.freeze({
					consumerAddress: consumer,
					requirementAddress: Override,
					providerAddress: provider,
				}),
				Object.freeze({
					consumerAddress: consumer,
					requirementAddress: InvalidOverride,
					providerAddress: absentProvider,
				}),
			]),
		})
		const catalog = createPluginCatalogSnapshot(7, [
			{ candidate: graphCandidate(Direct) },
			{ candidate: graphCandidate(OptionalPresent) },
			{ candidate: graphCandidate(Provider, { provides: AbstractDefault }) },
			{
				candidate: graphCandidate(Consumer, {
					requires: [Direct, AbstractDefault, Override, InvalidOverride, Unresolved],
					optional: [Direct, OptionalPresent, OptionalAbsent],
					forkable: true,
				}),
			},
			{
				candidate: graphCandidate(InvalidForkConsumer, { requires: [Direct] }),
			},
		])
		const graph = projectPluginDependencyGraph(host.ctx, {
			catalog,
			runtimeState: Object.freeze({ revision: 11, state }),
			reconciliation: Object.freeze([
				Object.freeze({
					kind: 'fork_not_allowed' as const,
					node: invalidFork,
					message: 'invalid fixture fork',
				}),
			]),
			sessionIntents: new Map(),
			desiredControl: new Map([
				[
					pluginNodeIndexKey(orphan),
					Object.freeze({ address: orphan, activationReason: 'auto-start' as const }),
				],
			]),
			applied: emptyAppliedPluginGraphSnapshot(),
			coreAdjacency: Object.freeze({
				nodes: Object.freeze([]),
				required: Object.freeze([]),
				optional: Object.freeze([]),
			}),
			runningNodes: Object.freeze([]),
		})
		expect(() => parsePluginDependencyGraphSnapshot(graph)).not.toThrow()

		const defaultEdges = graph.edges.filter(
			(edge) => pluginNodeIndexKey(edge.consumer) === pluginNodeIndexKey(consumer),
		)
		expect(edgeByRequirement(defaultEdges, Direct)).toMatchObject({
			mode: 'required',
			resolution: { state: 'resolved', via: 'direct' },
		})
		expect(edgeByRequirement(defaultEdges, AbstractDefault)).toMatchObject({
			resolution: { state: 'resolved', via: 'provider-default', provider },
		})
		expect(edgeByRequirement(defaultEdges, Override)).toMatchObject({
			resolution: { state: 'resolved', via: 'dependency-override', provider },
		})
		expect(edgeByRequirement(defaultEdges, InvalidOverride)).toMatchObject({
			resolution: {
				state: 'resolved',
				via: 'dependency-override',
				provider: absentProvider,
			},
		})
		expect(edgeByRequirement(defaultEdges, Unresolved)).toMatchObject({
			mode: 'required',
			resolution: { state: 'unresolved' },
			effective: false,
		})
		expect(edgeByRequirement(defaultEdges, OptionalPresent)).toMatchObject({
			mode: 'optional',
			resolution: { state: 'resolved', via: 'direct' },
			effective: false,
		})
		expect(edgeByRequirement(defaultEdges, OptionalAbsent)).toMatchObject({
			mode: 'optional',
			resolution: { state: 'resolved', via: 'direct' },
			effective: false,
		})
		expect(defaultEdges.filter((edge) => sameDefinition(edge.requirement, Direct))).toHaveLength(1)
		expect(
			graph.edges.filter(
				(edge) => pluginNodeIndexKey(edge.consumer) === pluginNodeIndexKey(consumerFork),
			),
		).toHaveLength(defaultEdges.length)
		expect(
			graph.edges.some(
				(edge) => pluginNodeIndexKey(edge.consumer) === pluginNodeIndexKey(invalidFork),
			),
		).toBe(false)
		expect(
			graph.edges.some(
				(edge) => pluginNodeIndexKey(edge.consumer) === pluginNodeIndexKey(graphNode(Orphan)),
			),
		).toBe(false)
	})

	it('returns graph_rejected with unchanged policy and graph for a cycle mutation', async () => {
		await using host = await createServiceInternalTestHarness({ workbench: false })

		const CycleTokenDefinition = pluginDefinitionAddressOf(CycleToken)
		host.add([CycleConsumer, CycleProvider, SafeProvider])
		host.cfg(CycleConsumer).setAutoStart(true)
		host.start(CycleConsumer)
		host.cfg(CycleProvider).setAutoStart(true)
		host.start(CycleProvider)
		host.cfg(SafeProvider).setAutoStart(true)
		host.start(SafeProvider)
		host.override(CycleConsumer, CycleTokenDefinition, pluginNodeAddressOf(SafeProvider))
		await host.commit()
		const rpc = new RuntimeManagementTargetImpl(host.ctx)
		const before = await rpc.pluginDependencyGraphDto()

		await expect(
			rpc.setPluginConsumerOverrideDto({
				consumer: pluginNodeAddressOf(CycleConsumer),
				requirement: CycleTokenDefinition,
				provider: pluginNodeAddressOf(CycleProvider),
			}),
		).resolves.toMatchObject({
			ok: false,
			code: 'graph_rejected',
			state: 'unchanged',
		})
		expect(requireHostStateStore(host.ctx).snapshot().dependencyOverrides).toEqual([
			expect.objectContaining({ providerAddress: pluginNodeAddressOf(SafeProvider) }),
		])
		expect(await rpc.pluginDependencyGraphDto()).toEqual(before)
	})
})

function graphDefinition(name: string): PluginDefinitionAddress {
	return Object.freeze({
		entry: Object.freeze({ kind: 'package-root' as const, packageName: `@graph/${name}` }),
		exportName: `${name}Plugin`,
	})
}

function graphNode(definition: PluginDefinitionAddress, forkId?: string): PluginNodeAddress {
	return forkId
		? Object.freeze({ definition, variant: 'fork' as const, forkId })
		: Object.freeze({ definition, variant: 'default' as const })
}

function graphCandidate(
	address: PluginDefinitionAddress,
	options: {
		requires?: readonly PluginDefinitionAddress[]
		optional?: readonly PluginDefinitionAddress[]
		provides?: PluginDefinitionAddress
		forkable?: boolean
	} = {},
): ConcretePluginDefinitionCandidate {
	class Implementation {}
	return Object.freeze({
		implementation: Implementation,
		declaration: Object.freeze({
			address,
			displayName: address.exportName,
			requires: Object.freeze([...(options.requires ?? [])]),
			optional: Object.freeze([...(options.optional ?? [])]),
			...(options.provides ? { provides: options.provides } : {}),
			parts: Object.freeze([]),
			forkable: options.forkable ?? false,
		}),
	}) as unknown as ConcretePluginDefinitionCandidate
}

function edgeByRequirement(
	edges: readonly { requirement: PluginDefinitionAddress }[],
	requirement: PluginDefinitionAddress,
) {
	return edges.find((edge) => sameDefinition(edge.requirement, requirement))
}

function sameDefinition(left: PluginDefinitionAddress, right: PluginDefinitionAddress): boolean {
	return pluginDefinitionIndexKey(left) === pluginDefinitionIndexKey(right)
}
