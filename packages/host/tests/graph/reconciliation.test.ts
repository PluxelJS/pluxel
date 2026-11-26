import { candidate, memoryStateStore, state } from './coordinator-fixture'
import {
	pluginDefinitionIndexKey,
	pluginNodeAddressEqual,
	pluginNodeIndexKey,
	type PluginDefinitionAddress,
	type PluginForkNodeAddress,
	type PluginNodeAddress,
} from '@pluxel/core'
import {
	catalogTransitionRejections,
	createPluginCatalogSnapshot,
	reconcilePluginGraph,
	PluginHostCoordinator,
	hostStatePatch,
	type CorePluginGraphDriver,
} from '@pluxel/host/internal'
import { describe, expect, it, vi } from 'vitest'

const definition = (name: string): PluginDefinitionAddress => ({
	entry: { kind: 'package-root', packageName: `@test/${name.toLowerCase()}` },
	exportName: `${name}Plugin`,
})

function node(address: PluginDefinitionAddress, forkId: string): PluginForkNodeAddress
function node(address: PluginDefinitionAddress): PluginNodeAddress
function node(address: PluginDefinitionAddress, forkId?: string): PluginNodeAddress {
	return forkId
		? { definition: address, variant: 'fork', forkId }
		: { definition: address, variant: 'default' }
}

describe('Host Plugin reconciliation', () => {
	it('blocks an incompatible selected provider without making it desired or materializing it', () => {
		const Requirement = definition('SelectedRequirement')
		const IncompatibleProvider = definition('SelectedIncompatibleProvider')
		const Consumer = definition('SelectedConsumer')
		const provider = node(IncompatibleProvider)
		const consumer = node(Consumer)
		const catalog = createPluginCatalogSnapshot(1, [
			{ candidate: candidate(IncompatibleProvider) },
			{ candidate: candidate(Consumer, { requires: [Requirement] }) },
		])
		const plan = reconcilePluginGraph({
			catalog,
			runtimeState: state({
				autoStart: [consumer],
				dependencyOverrides: [
					{
						consumerAddress: consumer,
						requirementAddress: Requirement,
						providerAddress: provider,
					},
				],
			}),
			runtimeStateRevision: 1,
		})

		expect(plan.blocked.map((issue) => issue.kind)).toContain('provider_incompatible')
		expect(plan.applied.nodes.has(pluginNodeIndexKey(consumer))).toBe(false)
		expect(plan.desiredControl.has(pluginNodeIndexKey(provider))).toBe(false)
		expect(plan.applied.nodes.has(pluginNodeIndexKey(provider))).toBe(false)
		expect(
			plan.coreOperations.some(
				(operation) =>
					operation.type === 'materialize-node' &&
					pluginNodeAddressEqual(operation.address, provider),
			),
		).toBe(false)
	})

	it('does not materialize a stopped durable fork', () => {
		const Provider = definition('Provider')
		const catalog = createPluginCatalogSnapshot(1, [
			{ candidate: candidate(Provider, { forkable: true }) },
		])
		const plan = reconcilePluginGraph({
			catalog,
			runtimeState: state({ forks: [{ definition: Provider, variant: 'fork', forkId: 'cold' }] }),
			runtimeStateRevision: 1,
		})

		expect(plan.coreOperations).toEqual([])
		expect(plan.applied.nodes.size).toBe(0)
	})

	it('reports a saved fork as blocked on cold boot if its implementation is no longer forkable', () => {
		const provider = definition('Archive')
		const fork = node(provider, 'east')
		const plan = reconcilePluginGraph({
			catalog: createPluginCatalogSnapshot(1, [{ candidate: candidate(provider) }]),
			runtimeState: state({ forks: [fork], autoStart: [fork] }),
			runtimeStateRevision: 1,
		})
		expect(plan.blocked.map((issue) => issue.kind)).toContain('fork_not_allowed')
		expect(plan.applied.nodes.has(pluginNodeIndexKey(fork))).toBe(false)
	})

	it('rejects optional edges that would bind through an abstract provider role', () => {
		const Token = definition('Token')
		const Provider = definition('Provider')
		const Consumer = definition('Consumer')

		expect(() =>
			createPluginCatalogSnapshot(1, [
				{ candidate: candidate(Consumer, { optional: [Token] }) },
				{ candidate: candidate(Provider, { provides: Token }) },
			]),
		).toThrow(/optional Plugin dependency.+cannot bind through an abstract provider role/)
		expect(() =>
			createPluginCatalogSnapshot(1, [{ candidate: candidate(Consumer, { optional: [Token] }) }]),
		).not.toThrow()
	})

	it('rejects abstract-provider contraction even when the explicit provider is stopped', () => {
		const Token = definition('Token')
		const Provider = definition('Provider')
		const Consumer = definition('Consumer')
		const previous = createPluginCatalogSnapshot(1, [
			{ candidate: candidate(Provider, { provides: Token }) },
			{ candidate: candidate(Consumer, { requires: [Token] }) },
		])
		const next = createPluginCatalogSnapshot(2, [
			{ candidate: candidate(Provider) },
			{ candidate: previous.byDefinition.get(pluginDefinitionIndexKey(Consumer))!.candidate },
		])
		const plan = reconcilePluginGraph({
			catalog: next,
			runtimeState: state({
				autoStart: [node(Consumer)],
				providerDefaults: [{ token: Token, provider: node(Provider) }],
			}),
			runtimeStateRevision: 1,
		})

		expect(plan.blocked.map((issue) => issue.kind)).toContain('provider_default_requires_abstract')
		expect(
			catalogTransitionRejections({ previous, next, plan }).map((issue) => issue.kind),
		).toContain('provider_default_requires_abstract')
	})

	it('rejects stopped explicit fork contraction before reporting availability', () => {
		const Provider = definition('Provider')
		const Consumer = definition('Consumer')
		const fork = node(Provider, 'cold')
		const consumer = node(Consumer)
		const previous = createPluginCatalogSnapshot(1, [
			{ candidate: candidate(Provider, { forkable: true }) },
			{ candidate: candidate(Consumer, { requires: [Provider] }) },
		])
		const next = createPluginCatalogSnapshot(2, [
			{ candidate: candidate(Provider, { forkable: false }) },
			{ candidate: previous.byDefinition.get(pluginDefinitionIndexKey(Consumer))!.candidate },
		])
		const plan = reconcilePluginGraph({
			catalog: next,
			runtimeState: state({
				autoStart: [consumer],
				forks: [{ definition: Provider, variant: 'fork', forkId: 'cold' }],
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
	})

	it('validates requirement removal for a non-auto-start override consumer', () => {
		const Provider = definition('Provider')
		const Consumer = definition('Consumer')
		const providerCandidate = candidate(Provider)
		const previous = createPluginCatalogSnapshot(1, [
			{ candidate: providerCandidate },
			{ candidate: candidate(Consumer, { requires: [Provider] }) },
		])
		const next = createPluginCatalogSnapshot(2, [
			{ candidate: providerCandidate },
			{ candidate: candidate(Consumer) },
		])
		const runtimeState = state({
			autoStart: [node(Provider)],
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
		const catalog = createPluginCatalogSnapshot(1, [{ candidate: candidate(Provider) }])
		const plan = reconcilePluginGraph({
			catalog,
			runtimeState: state({
				autoStart: [provider],
				providerDefaults: [{ token: Provider, provider }],
			}),
			runtimeStateRevision: 1,
		})

		expect(plan.blocked.map((issue) => issue.kind)).toContain('provider_default_requires_abstract')
		expect(plan.coreOperations.some((operation) => operation.type === 'set-provider-default')).toBe(
			false,
		)
	})

	it('blocks the dependent chain of a missing provider while admitting unrelated nodes', () => {
		const app = definition('App')
		const adapter = definition('Adapter')
		const missing = definition('MissingBackend')
		const independent = definition('Independent')
		const catalog = createPluginCatalogSnapshot(1, [
			{ candidate: candidate(app, { requires: [adapter] }) },
			{ candidate: candidate(adapter, { requires: [missing] }) },
			{ candidate: candidate(independent) },
		])
		const plan = reconcilePluginGraph({
			catalog,
			runtimeState: state({ autoStart: [node(app), node(independent)] }),
			runtimeStateRevision: 1,
		})

		expect(plan.blocked).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ consumer: node(app), requirement: adapter }),
				expect.objectContaining({ consumer: node(adapter), requirement: missing }),
			]),
		)
		expect(plan.coreOperations.filter(({ type }) => type === 'materialize-node')).toEqual([
			expect.objectContaining({ address: node(independent) }),
		])
	})
})

describe('Host Plugin graph publication', () => {
	it('publishes an incomplete cold-boot catalog with an explicit blocked report', async () => {
		const MissingProvider = definition('ColdBootMissingProvider')
		const Consumer = definition('ColdBootBlockedConsumer')
		const consumer = node(Consumer)
		const catalog = createPluginCatalogSnapshot(1, [
			{ candidate: candidate(Consumer, { requires: [MissingProvider] }) },
		])
		const coordinator = new PluginHostCoordinator(
			memoryStateStore(state({ autoStart: [consumer] })),
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
		const previous = createPluginCatalogSnapshot(1, [{ candidate: candidate(Provider) }])
		const next = createPluginCatalogSnapshot(2, [
			{ candidate: previous.entries[0]!.candidate },
			{ candidate: candidate(Consumer, { requires: [MissingProvider] }) },
		])
		const store = memoryStateStore(state({ autoStart: [provider] }))
		const coordinator = new PluginHostCoordinator(
			store,
			coreDriver(async ({ onGraphCommitted }) => {
				onGraphCommitted()
				return 'committed'
			}),
		)
		await coordinator.reconcileStartup(previous)
		const activateArtifacts = vi.fn()

		await expect(
			coordinator.update({
				catalog: next,
				onGraphCommitted: activateArtifacts,
				statePatch: hostStatePatch({
					type: 'set-auto-start',
					node: consumer,
					autoStart: true,
				}),
				lifecycleCommands: [{ address: consumer, desiredState: 'running' }],
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
		expect(activateArtifacts).not.toHaveBeenCalled()
		expect(coordinator.catalogSnapshot()).toBe(previous)
		expect(coordinator.reconciliationIssues()).toEqual([])
		expect(store.versionedSnapshot().state.autoStart).toEqual([provider])
	})

	it('publishes the coordinator catalog in the graph-confirmation stack', async () => {
		const Plugin = definition('Published')
		const catalog = createPluginCatalogSnapshot(1, [{ candidate: candidate(Plugin) }])
		const store = memoryStateStore(state({ autoStart: [node(Plugin)] }))
		const events: string[] = []
		let coordinator: PluginHostCoordinator<string>
		const driver = coreDriver(async ({ onGraphCommitted }) => {
			events.push(`before:${coordinator.catalogSnapshot().revision}`)
			onGraphCommitted()
			events.push(`after:${coordinator.catalogSnapshot().revision}`)
			return 'committed'
		})
		coordinator = new PluginHostCoordinator(store, driver)

		await coordinator.update({
			catalog,
			mode: 'cold-boot',
			onGraphCommitted: () => events.push(`artifacts:${coordinator.catalogSnapshot().revision}`),
		})
		expect(events).toEqual(['before:0', 'artifacts:1', 'after:1'])
	})

	it('keeps the coordinator catalog published after a post-PONR Core failure', async () => {
		const Plugin = definition('PointOfNoReturn')
		const firstCatalog = createPluginCatalogSnapshot(1, [{ candidate: candidate(Plugin) }])
		const runtimeState = state({ autoStart: [node(Plugin)] })
		const afterPonr = new PluginHostCoordinator(
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
				createPluginCatalogSnapshot(1, [{ candidate: candidate(Provider, { provides: Token }) }]),
				createPluginCatalogSnapshot(3, [{ candidate: candidate(Token) }]),
			],
			[
				createPluginCatalogSnapshot(1, [{ candidate: candidate(Token) }]),
				createPluginCatalogSnapshot(3, [{ candidate: candidate(Provider, { provides: Token }) }]),
			],
		] as const) {
			const coordinator = new PluginHostCoordinator(
				memoryStateStore(state()),
				coreDriver(async () => 'committed'),
			)
			await coordinator.reconcileStartup(first)
			const absent = createPluginCatalogSnapshot(2, [])
			await coordinator.updateCatalog(absent)

			await expect(coordinator.updateCatalog(conflicting)).rejects.toMatchObject({
				name: 'PluginCatalogError',
				code: 'plugin_definition_role_conflict',
			})
			expect(coordinator.catalogSnapshot()).toBe(absent)
		}
	})

	it('rejects restart for an unmaterialized node with a stable typed error', async () => {
		const Plugin = definition('UnavailableRestart')
		const coordinator = new PluginHostCoordinator(
			memoryStateStore(state()),
			coreDriver(async () => 'committed'),
		)
		await coordinator.reconcileStartup(
			createPluginCatalogSnapshot(1, [{ candidate: candidate(Plugin) }]),
		)

		await expect(coordinator.restartNode(node(Plugin))).rejects.toMatchObject({
			name: 'PluginRestartUnavailableError',
			code: 'restart_unavailable',
			state: 'unchanged',
			address: node(Plugin),
		})
	})
})

function coreDriver(
	commit: (options: { onGraphCommitted: () => void }) => Promise<string>,
	isRunning: (address: PluginNodeAddress) => boolean = () => false,
): CorePluginGraphDriver<string> {
	return {
		readCommittedDependencyAdjacency: () => ({ nodes: [], required: [], optional: [] }),
		isRunning,
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
