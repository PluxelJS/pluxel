import {
	pluginDefinitionAddressEqual,
	pluginDefinitionAddressOf,
	pluginDefinitionIndexKey,
	pluginNodeAddressEqual,
	type PluginDefinitionAddress,
	type PluginNodeAddress,
} from '@pluxel/core'
import type { ConcretePluginDefinitionCandidate } from '@pluxel/core/internal'
import {
	applyRuntimeStatePatch,
	catalogTransitionRejections,
	createPluginRouteCatalogSnapshot,
	installRuntimeRouteCapabilities,
	readRuntimeRouteCapabilities,
	reconcilePluginGraph,
	requireRuntimePluginGraphCoordinator,
	runtimePluginStatusOverview,
	RuntimePluginGraphCoordinator,
	RuntimeStateMutationRejectedError,
	runtimeStatePatch,
	validateRuntimeStateMutation,
	type CorePluginGraphDriver,
	type RuntimeStateCoordinatorStore,
	type RuntimeStateSnapshot,
} from '@pluxel/runtime/internal'
import { BasePlugin, createRuntimeHost, Plugin as PluginDecorator } from '@pluxel/runtime/test'
import { lowerTestPlugin } from '../helpers/lowered-plugin'
import { describe, expect, it } from 'vitest'

const definition = (name: string): PluginDefinitionAddress => ({
	entry: { kind: 'package-root', packageName: `@test/${name.toLowerCase()}` },
	exportName: `${name}Plugin`,
})

const node = (address: PluginDefinitionAddress, forkId?: string): PluginNodeAddress =>
	forkId
		? { definition: address, variant: 'fork', forkId }
		: { definition: address, variant: 'default' }

function candidate(
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

function state(input: Partial<RuntimeStateSnapshot> = {}): RuntimeStateSnapshot {
	return Object.freeze({
		enabled: Object.freeze([...(input.enabled ?? [])]),
		forks: Object.freeze([...(input.forks ?? [])]),
		providerDefaults: Object.freeze([...(input.providerDefaults ?? [])]),
		dependencyOverrides: Object.freeze([...(input.dependencyOverrides ?? [])]),
	})
}

describe('runtime-common Plugin reconciliation', () => {
	it('removes batched node policy through the reverse override index', () => {
		const Consumer = definition('IndexedConsumer')
		const Requirement = definition('IndexedRequirement')
		const provider = node(definition('IndexedProvider'))
		let addressReads = 0
		const count = 256
		const consumers = Array.from({ length: count }, (_, index) =>
			Object.freeze({
				get definition() {
					addressReads++
					return Consumer
				},
				variant: 'fork' as const,
				forkId: `consumer-${index}`,
			}),
		)
		const snapshot = state({
			enabled: consumers,
			dependencyOverrides: consumers.map((consumerAddress) => ({
				consumerAddress,
				requirementAddress: Requirement,
				providerAddress: provider,
			})),
		})

		const next = applyRuntimeStatePatch(
			snapshot,
			runtimeStatePatch(
				...consumers.map((consumer) => ({
					type: 'remove-node-policy' as const,
					node: consumer,
				})),
			),
		)

		expect(next.enabled).toEqual([])
		expect(next.dependencyOverrides).toEqual([])
		// A full scan per removal would read ~count² consumer addresses.
		expect(addressReads).toBeLessThan(count * 20)
	})

	it('infers an abstract default deterministically and persists it before graph apply', () => {
		const Token = definition('Token')
		const ProviderA = definition('ProviderA')
		const ProviderB = definition('ProviderB')
		const Consumer = definition('Consumer')
		const a = node(ProviderA)
		const b = node(ProviderB)
		const consumer = node(Consumer)
		const catalog = createPluginRouteCatalogSnapshot(1, [
			{ candidate: candidate(ProviderB, { provides: Token }) },
			{ candidate: candidate(Consumer, { requires: [Token] }) },
			{ candidate: candidate(ProviderA, { provides: Token }) },
		])
		const plan = reconcilePluginGraph({
			catalog,
			runtimeState: state({ enabled: [b, consumer, a] }),
			runtimeStateRevision: 7,
		})

		expect(plan.blocked).toEqual([])
		expect(plan.statePatch?.operations).toHaveLength(1)
		const inferred = plan.statePatch?.operations[0]
		expect(inferred?.type).toBe('set-provider-default')
		if (inferred?.type !== 'set-provider-default') throw new Error('expected inferred default')
		expect(pluginDefinitionAddressEqual(inferred.token, Token)).toBe(true)
		expect(pluginNodeAddressEqual(inferred.provider!, a)).toBe(true)
		expect(
			plan.coreOperations.filter((operation) => operation.type === 'materialize-node'),
		).toHaveLength(3)
	})

	it('preserves an explicit disabled provider and blocks instead of enabling or falling back', () => {
		const Token = definition('Token')
		const ProviderA = definition('ProviderA')
		const ProviderB = definition('ProviderB')
		const Consumer = definition('Consumer')
		const a = node(ProviderA)
		const b = node(ProviderB)
		const consumer = node(Consumer)
		const catalog = createPluginRouteCatalogSnapshot(1, [
			{ candidate: candidate(ProviderA, { provides: Token }) },
			{ candidate: candidate(ProviderB, { provides: Token }) },
			{ candidate: candidate(Consumer, { requires: [Token] }) },
		])
		const plan = reconcilePluginGraph({
			catalog,
			runtimeState: state({
				enabled: [a, consumer],
				providerDefaults: [{ token: Token, provider: b }],
			}),
			runtimeStateRevision: 1,
		})

		expect(plan.statePatch).toBeUndefined()
		expect(plan.blocked.map((issue) => issue.kind)).toContain('provider_disabled')
		expect(plan.blocked.map((issue) => issue.kind)).toContain('missing_required_provider')
		expect([...plan.applied.nodes.values()].map((entry) => entry.address)).toEqual([a])
	})

	it('allows a durable fork only as an explicit consumer override', () => {
		const Provider = definition('Provider')
		const Consumer = definition('Consumer')
		const fork = node(Provider, 'queue')
		const consumer = node(Consumer)
		const catalog = createPluginRouteCatalogSnapshot(1, [
			{ candidate: candidate(Provider, { forkable: true }) },
			{ candidate: candidate(Consumer, { requires: [Provider] }) },
		])
		const plan = reconcilePluginGraph({
			catalog,
			runtimeState: state({
				enabled: [fork, consumer],
				forks: [{ definition: Provider, forkIds: ['queue'] }],
				dependencyOverrides: [
					{
						consumerAddress: consumer,
						requirementAddress: Provider,
						providerAddress: fork,
					},
				],
			}),
			runtimeStateRevision: 1,
		})

		expect(plan.blocked).toEqual([])
		expect(
			plan.coreOperations.some(
				(operation) =>
					operation.type === 'set-dependency-override' &&
					operation.provider !== null &&
					pluginNodeAddressEqual(operation.provider, fork),
			),
		).toBe(true)
	})

	it('does not materialize a disabled durable fork', () => {
		const Provider = definition('Provider')
		const catalog = createPluginRouteCatalogSnapshot(1, [
			{ candidate: candidate(Provider, { forkable: true }) },
		])
		const plan = reconcilePluginGraph({
			catalog,
			runtimeState: state({ forks: [{ definition: Provider, forkIds: ['cold'] }] }),
			runtimeStateRevision: 1,
		})

		expect(plan.coreOperations).toEqual([])
		expect(plan.applied.nodes.size).toBe(0)
	})

	it('rejects optional edges that would bind through an abstract provider role', () => {
		const Token = definition('Token')
		const Provider = definition('Provider')
		const Consumer = definition('Consumer')

		expect(() =>
			createPluginRouteCatalogSnapshot(1, [
				{ candidate: candidate(Consumer, { optional: [Token] }) },
				{ candidate: candidate(Provider, { provides: Token }) },
			]),
		).toThrow(/optional Plugin dependency.+cannot bind through an abstract provider role/)
		expect(() =>
			createPluginRouteCatalogSnapshot(1, [
				{ candidate: candidate(Consumer, { optional: [Token] }) },
			]),
		).not.toThrow()
	})

	it('replaces one definition operation for all materialized variants', () => {
		const Provider = definition('Provider')
		const first = candidate(Provider, { forkable: true })
		const next = candidate(Provider, { forkable: true })
		const runtimeState = state({
			enabled: [node(Provider), node(Provider, 'east')],
			forks: [{ definition: Provider, forkIds: ['east'] }],
		})
		const firstCatalog = createPluginRouteCatalogSnapshot(1, [{ candidate: first }])
		const firstPlan = reconcilePluginGraph({
			catalog: firstCatalog,
			runtimeState,
			runtimeStateRevision: 1,
		})
		const nextCatalog = createPluginRouteCatalogSnapshot(2, [{ candidate: next }])
		const nextPlan = reconcilePluginGraph({
			catalog: nextCatalog,
			runtimeState,
			runtimeStateRevision: 1,
			applied: firstPlan.applied,
		})

		expect(
			nextPlan.coreOperations.filter((operation) => operation.type === 'replace-definition'),
		).toHaveLength(1)
		expect(
			nextPlan.coreOperations.filter((operation) => operation.type === 'materialize-node'),
		).toHaveLength(0)
	})

	it('rejects a live forkability contraction but reports it as blocked on cold boot', () => {
		const Provider = definition('Provider')
		const runtimeState = state({ forks: [{ definition: Provider, forkIds: ['east'] }] })
		const previous = createPluginRouteCatalogSnapshot(1, [
			{ candidate: candidate(Provider, { forkable: true }) },
		])
		const next = createPluginRouteCatalogSnapshot(2, [
			{ candidate: candidate(Provider, { forkable: false }) },
		])
		const plan = reconcilePluginGraph({
			catalog: next,
			runtimeState,
			runtimeStateRevision: 1,
		})

		expect(plan.blocked.map((issue) => issue.kind)).toEqual(['fork_not_allowed'])
		expect(catalogTransitionRejections({ previous, next, plan })).toEqual(plan.blocked)
	})

	it('rejects abstract-provider contraction even when the explicit provider is disabled', () => {
		const Token = definition('Token')
		const Provider = definition('Provider')
		const Consumer = definition('Consumer')
		const previous = createPluginRouteCatalogSnapshot(1, [
			{ candidate: candidate(Provider, { provides: Token }) },
			{ candidate: candidate(Consumer, { requires: [Token] }) },
		])
		const next = createPluginRouteCatalogSnapshot(2, [
			{ candidate: candidate(Provider) },
			{ candidate: previous.byDefinition.get(pluginDefinitionKey(Consumer))!.candidate },
		])
		const plan = reconcilePluginGraph({
			catalog: next,
			runtimeState: state({
				enabled: [node(Consumer)],
				providerDefaults: [{ token: Token, provider: node(Provider) }],
			}),
			runtimeStateRevision: 1,
		})

		expect(plan.blocked.map((issue) => issue.kind)).toContain('provider_default_requires_abstract')
		expect(
			catalogTransitionRejections({ previous, next, plan }).map((issue) => issue.kind),
		).toContain('provider_default_requires_abstract')
	})

	it('rejects disabled explicit fork contraction before reporting availability', () => {
		const Provider = definition('Provider')
		const Consumer = definition('Consumer')
		const fork = node(Provider, 'cold')
		const consumer = node(Consumer)
		const previous = createPluginRouteCatalogSnapshot(1, [
			{ candidate: candidate(Provider, { forkable: true }) },
			{ candidate: candidate(Consumer, { requires: [Provider] }) },
		])
		const next = createPluginRouteCatalogSnapshot(2, [
			{ candidate: candidate(Provider, { forkable: false }) },
			{ candidate: previous.byDefinition.get(pluginDefinitionKey(Consumer))!.candidate },
		])
		const plan = reconcilePluginGraph({
			catalog: next,
			runtimeState: state({
				enabled: [consumer],
				forks: [{ definition: Provider, forkIds: ['cold'] }],
				dependencyOverrides: [
					{
						consumerAddress: consumer,
						requirementAddress: Provider,
						providerAddress: fork,
					},
				],
			}),
			runtimeStateRevision: 1,
		})

		const kinds = catalogTransitionRejections({ previous, next, plan }).map((issue) => issue.kind)
		expect(kinds).toContain('fork_not_allowed')
		expect(kinds).toContain('explicit_binding_invalid')
		expect(plan.blocked.map((issue) => issue.kind)).not.toContain('provider_disabled')
	})

	it('validates requirement removal for a disabled override consumer', () => {
		const Provider = definition('Provider')
		const Consumer = definition('Consumer')
		const providerCandidate = candidate(Provider)
		const previous = createPluginRouteCatalogSnapshot(1, [
			{ candidate: providerCandidate },
			{ candidate: candidate(Consumer, { requires: [Provider] }) },
		])
		const next = createPluginRouteCatalogSnapshot(2, [
			{ candidate: providerCandidate },
			{ candidate: candidate(Consumer) },
		])
		const runtimeState = state({
			enabled: [node(Provider)],
			dependencyOverrides: [
				{
					consumerAddress: node(Consumer),
					requirementAddress: Provider,
					providerAddress: node(Provider),
				},
			],
		})
		const plan = reconcilePluginGraph({
			catalog: next,
			runtimeState,
			runtimeStateRevision: 1,
		})

		expect(plan.blocked.map((issue) => issue.kind)).toEqual(['requirement_removed'])
		expect(
			catalogTransitionRejections({ previous, next, plan }).map((issue) => issue.kind),
		).toEqual(['requirement_removed'])
	})

	it('blocks a concrete-token provider default without sending it to Core', () => {
		const Provider = definition('ConcreteDefaultProvider')
		const provider = node(Provider)
		const catalog = createPluginRouteCatalogSnapshot(1, [{ candidate: candidate(Provider) }])
		const plan = reconcilePluginGraph({
			catalog,
			runtimeState: state({
				enabled: [provider],
				providerDefaults: [{ token: Provider, provider }],
			}),
			runtimeStateRevision: 1,
		})

		expect(plan.blocked.map((issue) => issue.kind)).toContain('provider_default_requires_abstract')
		expect(plan.coreOperations.some((operation) => operation.type === 'set-provider-default')).toBe(
			false,
		)
	})

	it('commits source removal without rewriting explicit bindings and recovers on reappearance', () => {
		const Token = definition('Token')
		const Provider = definition('Provider')
		const Consumer = definition('Consumer')
		const provider = node(Provider)
		const consumer = node(Consumer)
		const runtimeState = state({
			enabled: [provider, consumer],
			providerDefaults: [{ token: Token, provider }],
			dependencyOverrides: [
				{
					consumerAddress: consumer,
					requirementAddress: Token,
					providerAddress: provider,
				},
			],
		})
		const providerCandidate = candidate(Provider, { provides: Token })
		const consumerCandidate = candidate(Consumer, { requires: [Token] })
		const previous = createPluginRouteCatalogSnapshot(1, [
			{ candidate: providerCandidate },
			{ candidate: consumerCandidate },
		])
		const applied = reconcilePluginGraph({
			catalog: previous,
			runtimeState,
			runtimeStateRevision: 1,
		}).applied
		const unlinked = createPluginRouteCatalogSnapshot(2, [{ candidate: consumerCandidate }])
		const unavailable = reconcilePluginGraph({
			catalog: unlinked,
			runtimeState,
			runtimeStateRevision: 1,
			applied,
		})

		expect(unavailable.statePatch).toBeUndefined()
		expect(unavailable.blocked.map((issue) => issue.kind)).toContain('provider_unavailable')
		expect(catalogTransitionRejections({ previous, next: unlinked, plan: unavailable })).toEqual([])
		expect(
			unavailable.coreOperations
				.filter((operation) => operation.type === 'dematerialize-node')
				.map((operation) => operation.address),
		).toEqual(expect.arrayContaining([provider, consumer]))

		const restored = createPluginRouteCatalogSnapshot(3, [
			{ candidate: providerCandidate },
			{ candidate: consumerCandidate },
		])
		const recovered = reconcilePluginGraph({
			catalog: restored,
			runtimeState,
			runtimeStateRevision: 1,
			applied: unavailable.applied,
		})
		expect(recovered.blocked).toEqual([])
		expect(recovered.statePatch).toBeUndefined()
		expect(
			recovered.coreOperations
				.filter((operation) => operation.type === 'materialize-node')
				.map((operation) => operation.address),
		).toEqual(expect.arrayContaining([provider, consumer]))
	})

	it('propagates a blocked dependency chain with one requirement scan per consumer', () => {
		const count = 96
		const definitions = Array.from({ length: count }, (_, index) =>
			definition(`Linear${String(index).padStart(3, '0')}`),
		)
		const Missing = definition('LinearMissing')
		let requirementReads = 0
		const candidates = definitions.map((address, index) => {
			const requirements = Object.freeze([definitions[index + 1] ?? Missing])
			const base = candidate(address, { requires: requirements })
			const declaration = { ...base.declaration }
			Object.defineProperty(declaration, 'requires', {
				enumerable: true,
				get: () => {
					requirementReads++
					return requirements
				},
			})
			return Object.freeze({
				...base,
				declaration: Object.freeze(declaration),
			}) as ConcretePluginDefinitionCandidate
		})
		const catalog = createPluginRouteCatalogSnapshot(
			1,
			candidates.map((tracked) => ({ candidate: tracked })),
		)

		const plan = reconcilePluginGraph({
			catalog,
			runtimeState: state({ enabled: definitions.map((address) => node(address)) }),
			runtimeStateRevision: 1,
		})

		expect(plan.blocked).toHaveLength(count)
		expect(requirementReads).toBe(count)
	})
})

function pluginDefinitionKey(address: PluginDefinitionAddress): string {
	return pluginDefinitionIndexKey(address)
}

describe('runtime-common Plugin graph publication', () => {
	it('publishes an incomplete cold-boot catalog with an explicit blocked report', async () => {
		const MissingProvider = definition('ColdBootMissingProvider')
		const Consumer = definition('ColdBootBlockedConsumer')
		const consumer = node(Consumer)
		const catalog = createPluginRouteCatalogSnapshot(1, [
			{ candidate: candidate(Consumer, { requires: [MissingProvider] }) },
		])
		const coordinator = new RuntimePluginGraphCoordinator(
			memoryStateStore(state({ enabled: [consumer] })),
			coreDriver(async () => 'unexpected-core-commit'),
		)

		const report = await coordinator.reconcileStartup(catalog)

		expect(report).toMatchObject({
			catalogRevision: 1,
			core: { status: 'unchanged' },
		})
		expect(report.reconciliation).toEqual([
			expect.objectContaining({
				kind: 'missing_required_provider',
				consumer,
				requirement: MissingProvider,
			}),
		])
		expect(coordinator.catalogSnapshot()).toBe(catalog)
		expect(coordinator.reconciliationIssues()).toEqual(report.reconciliation)
	})

	it('rejects a live invalid consumer addition without publishing its catalog', async () => {
		const Provider = definition('LiveStableProvider')
		const MissingProvider = definition('LiveMissingProvider')
		const Consumer = definition('LiveInvalidConsumer')
		const provider = node(Provider)
		const consumer = node(Consumer)
		const previous = createPluginRouteCatalogSnapshot(1, [{ candidate: candidate(Provider) }])
		const next = createPluginRouteCatalogSnapshot(2, [
			{ candidate: previous.entries[0]!.candidate },
			{ candidate: candidate(Consumer, { requires: [MissingProvider] }) },
		])
		const store = memoryStateStore(state({ enabled: [provider] }))
		const coordinator = new RuntimePluginGraphCoordinator(
			store,
			coreDriver(async ({ onGraphCommitted }) => {
				onGraphCommitted()
				return 'committed'
			}),
		)
		await coordinator.reconcileStartup(previous)

		await expect(
			coordinator.update({
				catalog: next,
				statePatch: runtimeStatePatch({
					type: 'set-enabled',
					node: consumer,
					enabled: true,
				}),
				mode: 'live',
			}),
		).rejects.toMatchObject({
			name: 'PluginGraphRejectedError',
			code: 'graph_rejected',
			issues: [
				expect.objectContaining({
					kind: 'missing_required_provider',
					consumer,
					requirement: MissingProvider,
				}),
			],
		})
		expect(coordinator.catalogSnapshot()).toBe(previous)
		expect(coordinator.reconciliationIssues()).toEqual([])
		expect(store.versionedSnapshot().state.enabled).toEqual([provider])
	})

	it('publishes the coordinator catalog in the graph-confirmation stack', async () => {
		const Plugin = definition('Published')
		const catalog = createPluginRouteCatalogSnapshot(1, [{ candidate: candidate(Plugin) }])
		const store = memoryStateStore(state({ enabled: [node(Plugin)] }))
		const events: string[] = []
		let coordinator: RuntimePluginGraphCoordinator<string>
		const driver = coreDriver(async ({ onGraphCommitted }) => {
			events.push(`before:${coordinator.catalogSnapshot().revision}`)
			onGraphCommitted()
			events.push(`after:${coordinator.catalogSnapshot().revision}`)
			return 'committed'
		})
		coordinator = new RuntimePluginGraphCoordinator(store, driver)

		await coordinator.update({
			catalog,
			mode: 'cold-boot',
		})
		expect(events).toEqual(['before:0', 'after:1'])
	})

	it('keeps the coordinator catalog published after a post-PONR Core failure', async () => {
		const Plugin = definition('PointOfNoReturn')
		const firstCatalog = createPluginRouteCatalogSnapshot(1, [{ candidate: candidate(Plugin) }])
		const runtimeState = state({ enabled: [node(Plugin)] })
		const afterPonr = new RuntimePluginGraphCoordinator(
			memoryStateStore(runtimeState),
			coreDriver(async ({ onGraphCommitted }) => {
				onGraphCommitted()
				throw new Error('post-confirm failure')
			}),
		)
		await expect(
			afterPonr.update({
				catalog: firstCatalog,
				mode: 'cold-boot',
			}),
		).rejects.toThrow('post-confirm failure')
		expect(afterPonr.catalogSnapshot()).toBe(firstCatalog)
	})

	it('rejects definition role changes across an absent intermediate catalog', async () => {
		const Token = definition('StableRoleToken')
		const Provider = definition('StableRoleProvider')

		for (const [first, conflicting] of [
			[
				createPluginRouteCatalogSnapshot(1, [
					{ candidate: candidate(Provider, { provides: Token }) },
				]),
				createPluginRouteCatalogSnapshot(3, [{ candidate: candidate(Token) }]),
			],
			[
				createPluginRouteCatalogSnapshot(1, [{ candidate: candidate(Token) }]),
				createPluginRouteCatalogSnapshot(3, [
					{ candidate: candidate(Provider, { provides: Token }) },
				]),
			],
		] as const) {
			const coordinator = new RuntimePluginGraphCoordinator(
				memoryStateStore(state()),
				coreDriver(async () => 'committed'),
			)
			await coordinator.reconcileStartup(first)
			const absent = createPluginRouteCatalogSnapshot(2, [])
			await coordinator.updateCatalog(absent)

			await expect(coordinator.updateCatalog(conflicting)).rejects.toMatchObject({
				name: 'PluginCatalogError',
				code: 'plugin_definition_role_conflict',
			})
			expect(coordinator.catalogSnapshot()).toBe(absent)
		}
	})

	it('restarts an applied node without scanning or reconciling the catalog', async () => {
		const Plugin = definition('FastRestart')
		const base = createPluginRouteCatalogSnapshot(1, [{ candidate: candidate(Plugin) }])
		let rejectCatalogScan = false
		const guardedCatalog = Object.freeze({
			...base,
			entries: new Proxy(base.entries, {
				get(target, property, receiver) {
					if (rejectCatalogScan && property === Symbol.iterator) {
						throw new Error('restart scanned the full catalog')
					}
					return Reflect.get(target, property, receiver)
				},
			}),
		})
		const coordinator = new RuntimePluginGraphCoordinator(
			memoryStateStore(state({ enabled: [node(Plugin)] })),
			coreDriver(async ({ onGraphCommitted }) => {
				onGraphCommitted()
				return 'committed'
			}),
		)
		await coordinator.reconcileStartup(guardedCatalog)
		rejectCatalogScan = true

		await expect(coordinator.restartNode(node(Plugin))).resolves.toMatchObject({
			catalogRevision: 1,
			core: { status: 'committed', summary: 'committed' },
		})
	})

	it('rejects restart for an unmaterialized node with a stable typed error', async () => {
		const Plugin = definition('UnavailableRestart')
		const coordinator = new RuntimePluginGraphCoordinator(
			memoryStateStore(state()),
			coreDriver(async () => 'committed'),
		)
		await coordinator.reconcileStartup(
			createPluginRouteCatalogSnapshot(1, [{ candidate: candidate(Plugin) }]),
		)

		await expect(coordinator.restartNode(node(Plugin))).rejects.toMatchObject({
			name: 'PluginRestartUnavailableError',
			code: 'restart_unavailable',
			state: 'unchanged',
			address: node(Plugin),
		})
	})
})

describe('runtime-common pinned mutation admission', () => {
	it('rejects a queued first enable after the catalog definition is unlinked', async () => {
		const Plugin = definition('QueuedEnable')
		const address = node(Plugin)
		const store = memoryStateStore(state())
		const coordinator = new RuntimePluginGraphCoordinator(
			store,
			coreDriver(async () => 'committed'),
		)
		await coordinator.reconcileStartup(
			createPluginRouteCatalogSnapshot(1, [{ candidate: candidate(Plugin) }]),
		)

		const unlink = coordinator.updateCatalog(createPluginRouteCatalogSnapshot(2, []))
		const enable = coordinator.updateRuntimeState(
			runtimeStatePatch({ type: 'set-enabled', node: address, enabled: true }),
		)
		await unlink
		await expect(enable).rejects.toMatchObject({ code: 'node_unavailable' })
		expect(store.versionedSnapshot().state.enabled).toEqual([])
	})

	it('admits a bulk patch from one indexed prospective-state build', () => {
		const requirement = definition('BulkRequirement')
		let consumerDefinitionReads = 0
		const dependencyOverrides = Array.from({ length: 80 }, (_, index) => {
			const address = node(definition(`BulkConsumer${String(index).padStart(3, '0')}`))
			const consumer = Object.freeze(
				Object.defineProperty({ ...address }, 'definition', {
					enumerable: true,
					get: () => {
						consumerDefinitionReads++
						return address.definition
					},
				}),
			) as PluginNodeAddress
			return {
				consumerAddress: consumer,
				requirementAddress: requirement,
				providerAddress: node(definition(`BulkProvider${String(index).padStart(3, '0')}`)),
			}
		})
		const operations = Array.from({ length: 80 }, (_, index) => ({
			type: 'set-enabled' as const,
			node: node(definition(`Absent${String(index).padStart(3, '0')}`)),
			enabled: false,
		}))

		validateRuntimeStateMutation(
			createPluginRouteCatalogSnapshot(1, []),
			state({ dependencyOverrides }),
			runtimeStatePatch(...operations),
		)
		expect(consumerDefinitionReads).toBeLessThanOrEqual(dependencyOverrides.length * 4)
	})

	it('rejects a queued first fork after definition unlink or forkability contraction', async () => {
		const Provider = definition('QueuedForkProvider')
		const forkable = createPluginRouteCatalogSnapshot(1, [
			{ candidate: candidate(Provider, { forkable: true }) },
		])

		for (const next of [
			createPluginRouteCatalogSnapshot(2, []),
			createPluginRouteCatalogSnapshot(2, [
				{ candidate: candidate(Provider, { forkable: false }) },
			]),
		]) {
			const store = memoryStateStore(state())
			const coordinator = new RuntimePluginGraphCoordinator(
				store,
				coreDriver(async () => 'ok'),
			)
			await coordinator.reconcileStartup(forkable)

			const catalogUpdate = coordinator.updateCatalog(next)
			const ensureFork = coordinator.updateRuntimeState(
				runtimeStatePatch({ type: 'ensure-fork', definition: Provider, forkId: 'queued' }),
			)
			await catalogUpdate
			await expect(ensureFork).rejects.toMatchObject({
				name: 'RuntimeStateMutationRejectedError',
				code: next.entries.length === 0 ? 'definition_unavailable' : 'not_forkable',
			})
			expect(store.versionedSnapshot().state.forks).toEqual([])
		}
	})

	it('rejects fork removal against an override inserted earlier in the same host queue', async () => {
		const Provider = definition('ReferencedForkProvider')
		const Consumer = definition('ReferencedForkConsumer')
		const fork = node(Provider, 'retained')
		const consumer = node(Consumer)
		const store = memoryStateStore(
			state({ forks: [{ definition: Provider, forkIds: ['retained'] }] }),
		)
		const coordinator = new RuntimePluginGraphCoordinator(
			store,
			coreDriver(async () => 'ok'),
		)
		await coordinator.reconcileStartup(
			createPluginRouteCatalogSnapshot(1, [
				{ candidate: candidate(Provider, { forkable: true }) },
				{ candidate: candidate(Consumer, { requires: [Provider] }) },
			]),
		)

		const insertOverride = coordinator.updateRuntimeState(
			runtimeStatePatch({
				type: 'set-dependency-override',
				consumer,
				requirement: Provider,
				provider: fork,
			}),
		)
		let metadataCleanups = 0
		const removeFork = coordinator.runExclusive('test-remove-fork', async (session) => {
			const patch = runtimeStatePatch({
				type: 'remove-fork',
				definition: Provider,
				forkId: 'retained',
			})
			session.validateRuntimeStatePatch(patch)
			metadataCleanups++
			return session.update({ statePatch: patch })
		})
		await insertOverride
		await expect(removeFork).rejects.toSatisfy((error: unknown) => {
			if (!(error instanceof RuntimeStateMutationRejectedError)) return false
			return (
				error.code === 'fork_referenced' &&
				error.issue.code === 'fork_referenced' &&
				error.issue.references.length === 1 &&
				pluginNodeAddressEqual(error.issue.references[0]!.consumer, consumer)
			)
		})
		const snapshot = store.versionedSnapshot().state
		expect(snapshot.forks).toEqual([{ definition: Provider, forkIds: ['retained'] }])
		expect(snapshot.dependencyOverrides).toHaveLength(1)
		expect(metadataCleanups).toBe(0)
	})

	it('does not let a later override interleave with fork metadata cleanup', async () => {
		const Provider = definition('ExclusiveForkProvider')
		const Consumer = definition('ExclusiveForkConsumer')
		const fork = node(Provider, 'exclusive')
		const consumer = node(Consumer)
		const store = memoryStateStore(
			state({
				enabled: [fork],
				forks: [{ definition: Provider, forkIds: ['exclusive'] }],
			}),
		)
		const coordinator = new RuntimePluginGraphCoordinator(
			store,
			coreDriver(async () => 'ok'),
		)
		await coordinator.reconcileStartup(
			createPluginRouteCatalogSnapshot(1, [
				{ candidate: candidate(Provider, { forkable: true }) },
				{ candidate: candidate(Consumer, { requires: [Provider] }) },
			]),
		)
		let enteredMetadata!: () => void
		const metadataEntered = new Promise<void>((resolve) => {
			enteredMetadata = resolve
		})
		let releaseMetadata!: () => void
		const metadataRelease = new Promise<void>((resolve) => {
			releaseMetadata = resolve
		})
		let metadataCleanups = 0
		const removeFork = coordinator.runExclusive('test-exclusive-remove', async (session) => {
			const removalPatch = runtimeStatePatch(
				{ type: 'remove-node-policy', node: fork },
				{ type: 'remove-fork', definition: Provider, forkId: 'exclusive' },
			)
			session.validateRuntimeStatePatch(removalPatch)
			await session.update({
				statePatch: runtimeStatePatch({ type: 'set-enabled', node: fork, enabled: false }),
			})
			metadataCleanups++
			enteredMetadata()
			await metadataRelease
			return session.update({ statePatch: removalPatch })
		})
		await metadataEntered
		const insertOverride = coordinator.updateRuntimeState(
			runtimeStatePatch({
				type: 'set-dependency-override',
				consumer,
				requirement: Provider,
				provider: fork,
			}),
		)
		releaseMetadata()
		await removeFork
		await expect(insertOverride).rejects.toMatchObject({ code: 'provider_unavailable' })
		expect(metadataCleanups).toBe(1)
		expect(store.versionedSnapshot().state.forks).toEqual([])
		expect(store.versionedSnapshot().state.dependencyOverrides).toEqual([])
	})

	it('admits disabled structural bindings but rejects new invalid intent at serialization', async () => {
		const Token = definition('AdmissionToken')
		const Provider = definition('AdmissionProvider')
		const Consumer = definition('AdmissionConsumer')
		const provider = node(Provider)
		const consumer = node(Consumer)
		const catalog = createPluginRouteCatalogSnapshot(1, [
			{ candidate: candidate(Provider, { provides: Token }) },
			{ candidate: candidate(Consumer, { requires: [Token] }) },
		])
		const store = memoryStateStore(state())
		const coordinator = new RuntimePluginGraphCoordinator(
			store,
			coreDriver(async () => 'ok'),
		)
		await coordinator.reconcileStartup(catalog)

		await coordinator.updateRuntimeState(
			runtimeStatePatch({
				type: 'set-dependency-override',
				consumer,
				requirement: Token,
				provider,
			}),
		)
		expect(store.versionedSnapshot().state.dependencyOverrides).toHaveLength(1)

		const absent = definition('AbsentProvider')
		await expect(
			coordinator.updateRuntimeState(
				runtimeStatePatch({
					type: 'set-dependency-override',
					consumer,
					requirement: Token,
					provider: node(absent),
				}),
			),
		).rejects.toMatchObject({ code: 'provider_unavailable' })
		expect(store.versionedSnapshot().state.dependencyOverrides[0]?.providerAddress).toEqual(
			provider,
		)
	})
})

describe('runtime host-owned graph state', () => {
	it('isolates coordinators by root and removes a disposed host identity', async () => {
		const first = createRuntimeHost()
		const second = createRuntimeHost()
		const firstCoordinator = requireRuntimePluginGraphCoordinator(first.ctx)
		const child = first.ctx.extend({ name: 'child' })
		try {
			expect(requireRuntimePluginGraphCoordinator(child)).toBe(firstCoordinator)
			expect(requireRuntimePluginGraphCoordinator(second.ctx)).not.toBe(firstCoordinator)
			await first.dispose()
			expect(() => requireRuntimePluginGraphCoordinator(child)).toThrow(/did not install/)
			expect(() => requireRuntimePluginGraphCoordinator(second.ctx)).not.toThrow()
		} finally {
			await first.dispose()
			await second.dispose()
		}
	})

	it('isolates immutable route snapshots and skips disposed lower installations', async () => {
		const first = createRuntimeHost()
		const second = createRuntimeHost()
		const child = first.ctx.extend({ name: 'child' })
		const base = {
			dynamicPluginSources: { hasFile: () => true, hasDirectory: () => true },
		}
		const modules = {
			normalizeId: (id: string) => id,
			moduleIdAliases: (id: string) => [id],
			primeModuleCacheEntry() {},
			dropModuleCacheEntries() {},
		}
		const uninstallBase = installRuntimeRouteCapabilities(first.ctx, base)
		const uninstallOverlay = installRuntimeRouteCapabilities(first.ctx, { ...base, modules })
		try {
			expect(readRuntimeRouteCapabilities(child)?.modules).toBe(modules)
			expect(readRuntimeRouteCapabilities(second.ctx)).toBeUndefined()
			uninstallBase()
			expect(readRuntimeRouteCapabilities(first.ctx)?.modules).toBe(modules)
			uninstallOverlay()
			expect(readRuntimeRouteCapabilities(first.ctx)).toBeUndefined()
		} finally {
			uninstallOverlay()
			uninstallBase()
			await first.dispose()
			await second.dispose()
		}
	})

	it('keeps enabled and disabled durable orphan nodes visible after source unlink', async () => {
		@PluginDecorator({ forkable: true })
		class Orphan extends BasePlugin {}
		lowerTestPlugin(Orphan)
		const host = createRuntimeHost()
		const base = node(pluginDefinitionAddressOf(Orphan))
		const fork = host.fork(Orphan, 'disabled')
		try {
			host.cfg(Orphan).enable()
			await host.commit()
			host.remove(Orphan)
			await host.commit()

			const statuses = runtimePluginStatusOverview(host.ctx).statuses
			const enabled = statuses.find((status) => pluginNodeAddressEqual(status.address, base))
			const disabled = statuses.find((status) => pluginNodeAddressEqual(status.address, fork))
			expect(enabled).toMatchObject({
				isEnabled: true,
				isRunning: false,
				lifecycleStage: 'stopped',
				availability: 'unavailable',
			})
			expect(enabled?.issues.map((issue) => issue.code)).toContain('consumer_unavailable')
			expect(enabled?.issues.every((issue) => issue.id.length > 0)).toBe(true)
			expect(disabled).toMatchObject({
				isEnabled: false,
				isRunning: false,
				lifecycleStage: 'disabled',
				availability: 'unavailable',
			})
			expect(disabled?.issues.map((issue) => issue.code)).toContain('definition_unavailable')
			expect(disabled?.issues[0]?.id).toContain('definition_unavailable:')
		} finally {
			await host.dispose()
		}
	})
})

function memoryStateStore(initial: RuntimeStateSnapshot): RuntimeStateCoordinatorStore {
	let current = { revision: 0, state: initial }
	return {
		ready: Promise.resolve(),
		versionedSnapshot: () => current,
		commitVersioned: async (expectedRevision, next) => {
			if (expectedRevision !== current.revision) throw new Error('unexpected revision conflict')
			current = { revision: current.revision + 1, state: next }
			return current
		},
	}
}

function coreDriver(
	commit: (options: { onGraphCommitted: () => void }) => Promise<string>,
): CorePluginGraphDriver<string> {
	return {
		beginUpdate: () => ({
			materializeNode() {},
			dematerializeNode() {},
			restartNode() {},
			replaceDefinition() {},
			setProviderDefault() {},
			setDependencyOverride() {},
			prepare: () => ({ commit, rollback() {} }),
			rollback() {},
		}),
	}
}
