import {
	formatPluginNodeReference,
	pluginNodeIndexKey,
	type CommitSummary,
	type PluginDefinitionAddress,
	type PluginNodeAddress,
} from '@pluxel/core'
import type { ConcretePluginDefinitionCandidate } from '@pluxel/core/internal'
import {
	RuntimeStateRevisionConflictError,
	type RuntimeStateSnapshot,
	type RuntimeStateVersionedSnapshot,
} from '../../services/RuntimeStateStore'
import {
	emptyPluginRouteCatalogSnapshot,
	extendPluginDefinitionRoleHistory,
	type PluginDefinitionRoleHistory,
	type PluginRouteCatalogSnapshot,
} from './catalog'
import { applyRuntimeStatePatch, runtimeStateEqual, type RuntimeStatePatch } from './state'
import { applyRuntimeStateMutation, validateRuntimeStateMutation } from './mutation'
import {
	catalogTransitionRejections,
	emptyAppliedPluginGraphSnapshot,
	reconcilePluginGraph,
	type AppliedPluginGraphSnapshot,
	type CorePluginOperation,
	type PluginReconciliationIssue,
} from './reconcile'

export interface CorePluginPreparedUpdate<TSummary = unknown> {
	commit(options: { onGraphCommitted: () => void }): Promise<TSummary>
	rollback(): void
}

export interface CorePluginUpdateDraft<TSummary = unknown> {
	materializeNode(address: PluginNodeAddress, candidate: ConcretePluginDefinitionCandidate): void
	dematerializeNode(address: PluginNodeAddress, options: { cascadeDependents: true }): void
	restartNode(address: PluginNodeAddress, options: { cascadeDependents: true }): void
	replaceDefinition(
		address: PluginDefinitionAddress,
		candidate: ConcretePluginDefinitionCandidate,
		options: { cascadeDependents: true },
	): void
	setProviderDefault(token: PluginDefinitionAddress, provider: PluginNodeAddress | null): void
	setDependencyOverride(
		consumer: PluginNodeAddress,
		requirement: PluginDefinitionAddress,
		provider: PluginNodeAddress | null,
	): void
	prepare(): Promise<CorePluginPreparedUpdate<TSummary>> | CorePluginPreparedUpdate<TSummary>
	rollback(): void
}

export interface CorePluginGraphDriver<TSummary = unknown> {
	beginUpdate(options: { reason: string }): CorePluginUpdateDraft<TSummary>
}

export interface RuntimeStateCoordinatorStore {
	readonly ready: Promise<void>
	versionedSnapshot(): RuntimeStateVersionedSnapshot
	commitVersioned(
		expectedRevision: number,
		next: RuntimeStateSnapshot,
	): Promise<RuntimeStateVersionedSnapshot>
}

export type PluginApplyReport<TSummary = CommitSummary> = Readonly<{
	catalogRevision: number
	runtimeStateRevision: number
	reconciliation: readonly PluginReconciliationIssue[]
	core: Readonly<{ status: 'unchanged' }> | Readonly<{ status: 'committed'; summary: TSummary }>
}>

export class PluginGraphRejectedError extends Error {
	public readonly code = 'graph_rejected' as const

	constructor(public readonly issues: readonly PluginReconciliationIssue[]) {
		super('[runtime:reconciliation] catalog update would invalidate committed graph policy')
		this.name = 'PluginGraphRejectedError'
	}
}

export class RuntimeStatePersistenceError extends Error {
	public readonly code = 'persistence_failed' as const
	public readonly state = 'unknown' as const

	constructor(cause: unknown) {
		super('[runtime:reconciliation] failed to persist desired runtime state', { cause })
		this.name = 'RuntimeStatePersistenceError'
	}
}

export class PluginRestartUnavailableError extends Error {
	public readonly code = 'restart_unavailable' as const
	public readonly state = 'unchanged' as const

	constructor(public readonly address: PluginNodeAddress) {
		super(
			`[runtime:reconciliation] cannot restart an unmaterialized Plugin node: ${formatPluginNodeReference(address)}`,
		)
		this.name = 'PluginRestartUnavailableError'
	}
}

export type RuntimePluginGraphUpdate = Readonly<{
	reason?: string
	catalog?: PluginRouteCatalogSnapshot
	statePatch?: RuntimeStatePatch
	/** Cold boot has no last-known-good catalog and therefore projects structural issues as blocked. */
	mode?: 'cold-boot' | 'live'
	restartNodes?: readonly PluginNodeAddress[]
}>

export interface RuntimePluginGraphExclusiveSession<TSummary = unknown> {
	runtimeStateSnapshot(): RuntimeStateSnapshot
	validateRuntimeStatePatch(patch: RuntimeStatePatch): void
	update(update: RuntimePluginGraphUpdate): Promise<PluginApplyReport<TSummary>>
}

type QueuedRuntimePluginGraphUpdate = RuntimePluginGraphUpdate & Readonly<{ reason: string }>

/**
 * The single graph-affecting mutation queue for one host.
 *
 * Routes submit immutable catalog snapshots; control-plane code submits address-only state
 * patches. No route-specific fork/provider policy is accepted by this boundary.
 */
export class RuntimePluginGraphCoordinator<TSummary = unknown> {
	private catalog: PluginRouteCatalogSnapshot = emptyPluginRouteCatalogSnapshot()
	private definitionRoles: PluginDefinitionRoleHistory = new Map()
	private applied: AppliedPluginGraphSnapshot = emptyAppliedPluginGraphSnapshot()
	private reconciliation: readonly PluginReconciliationIssue[] = Object.freeze([])
	private tail: Promise<void> = Promise.resolve()
	private disposed = false

	constructor(
		private readonly runtimeState: RuntimeStateCoordinatorStore,
		private readonly core: CorePluginGraphDriver<TSummary>,
	) {}

	catalogSnapshot(): PluginRouteCatalogSnapshot {
		return this.catalog
	}

	reconciliationIssues(): readonly PluginReconciliationIssue[] {
		return this.reconciliation
	}

	/**
	 * Atomically reconcile one host-owned desired-state change. This is the composition boundary
	 * used when a caller must publish a catalog revision, a RuntimeState patch, and explicit
	 * restarts as one prepared Core transaction.
	 */
	update(update: RuntimePluginGraphUpdate): Promise<PluginApplyReport<TSummary>> {
		return this.enqueue(
			Object.freeze({
				...update,
				reason: update.reason ?? 'runtime-graph-update',
				...(update.restartNodes ? { restartNodes: Object.freeze([...update.restartNodes]) } : {}),
			}),
		)
	}

	reconcileStartup(
		catalog: PluginRouteCatalogSnapshot,
		reason = 'startup',
	): Promise<PluginApplyReport<TSummary>> {
		return this.enqueue({ reason, catalog, mode: 'cold-boot' })
	}

	updateCatalog(
		catalog: PluginRouteCatalogSnapshot,
		reason = 'catalog-update',
	): Promise<PluginApplyReport<TSummary>> {
		return this.enqueue({ reason, catalog, mode: 'live' })
	}

	updateRuntimeState(
		statePatch: RuntimeStatePatch,
		reason = 'runtime-state-update',
	): Promise<PluginApplyReport<TSummary>> {
		return this.enqueue({ reason, statePatch, mode: 'live' })
	}

	reconcile(reason = 'reconcile'): Promise<PluginApplyReport<TSummary>> {
		return this.enqueue({ reason, mode: 'live' })
	}

	restartNode(
		address: PluginNodeAddress,
		reason = 'plugin-restart',
	): Promise<PluginApplyReport<TSummary>> {
		return this.enqueue({ reason, mode: 'live', restartNodes: Object.freeze([address]) })
	}

	/** @internal Bounded multi-resource sequence on this host's graph mutation queue. */
	runExclusive<T>(
		reason: string,
		run: (session: RuntimePluginGraphExclusiveSession<TSummary>) => Promise<T>,
	): Promise<T> {
		if (this.disposed) {
			return Promise.reject(new Error('[runtime:reconciliation] coordinator is disposed'))
		}
		const execute = this.tail.then(async () => {
			await this.runtimeState.ready
			const session: RuntimePluginGraphExclusiveSession<TSummary> = Object.freeze({
				runtimeStateSnapshot: () => this.runtimeState.versionedSnapshot().state,
				validateRuntimeStatePatch: (patch: RuntimeStatePatch) =>
					validateRuntimeStateMutation(
						this.catalog,
						this.runtimeState.versionedSnapshot().state,
						patch,
					),
				update: (update: RuntimePluginGraphUpdate) =>
					this.applyUpdate(
						Object.freeze({
							...update,
							reason: update.reason ?? reason,
							...(update.restartNodes
								? { restartNodes: Object.freeze([...update.restartNodes]) }
								: {}),
						}),
					),
			})
			return run(session)
		})
		this.tail = execute.then(
			(): void => undefined,
			(): void => undefined,
		)
		return execute
	}

	dispose(): Promise<void> {
		this.disposed = true
		return this.tail
	}

	private enqueue(update: QueuedRuntimePluginGraphUpdate): Promise<PluginApplyReport<TSummary>> {
		if (this.disposed) {
			return Promise.reject(new Error('[runtime:reconciliation] coordinator is disposed'))
		}
		const run = this.tail.then(() => this.applyUpdate(update))
		this.tail = run.then(
			(): void => undefined,
			(): void => undefined,
		)
		return run
	}

	private async applyUpdate(
		update: QueuedRuntimePluginGraphUpdate,
	): Promise<PluginApplyReport<TSummary>> {
		await this.runtimeState.ready
		if (!update.catalog && !update.statePatch && update.restartNodes !== undefined) {
			return this.applyRestartOnly(update.reason, update.restartNodes)
		}
		for (;;) {
			const committedCatalog = this.catalog
			const proposedCatalog = update.catalog ?? committedCatalog
			this.assertCatalogRevision(committedCatalog, proposedCatalog)
			// Prepare the complete role-history replacement before persistence, Core prepare, and PONR.
			// Failed proposals never poison the host-lifetime tombstones.
			const preparedDefinitionRoles = update.catalog
				? extendPluginDefinitionRoleHistory(this.definitionRoles, proposedCatalog)
				: this.definitionRoles
			const pinnedState = this.runtimeState.versionedSnapshot()
			const prospectiveState = applyRuntimeStateMutation(
				proposedCatalog,
				pinnedState.state,
				update.statePatch,
			)
			const initialPlan = reconcilePluginGraph({
				catalog: proposedCatalog,
				runtimeState: prospectiveState,
				runtimeStateRevision: pinnedState.revision,
				applied: this.applied,
			})
			const nextState = applyRuntimeStatePatch(prospectiveState, initialPlan.statePatch)
			const plan = initialPlan.statePatch
				? reconcilePluginGraph({
						catalog: proposedCatalog,
						runtimeState: nextState,
						runtimeStateRevision: pinnedState.revision,
						applied: this.applied,
					})
				: initialPlan

			if (update.mode !== 'cold-boot' && update.catalog) {
				const rejected = catalogTransitionRejections({
					previous: committedCatalog,
					next: proposedCatalog,
					plan,
				})
				if (rejected.length > 0) throw new PluginGraphRejectedError(rejected)
			}

			if (!this.revisionsMatch(committedCatalog, pinnedState)) continue
			const operations: CorePluginOperation[] = [...plan.coreOperations]
			for (const address of update.restartNodes ?? []) {
				if (!plan.applied.nodes.has(pluginNodeKey(address))) {
					throw new PluginRestartUnavailableError(address)
				}
				operations.push({
					type: 'restart-node',
					address,
					cascadeDependents: true,
				})
			}
			const prepared = await this.prepareCore(update.reason, operations)
			if (!this.revisionsMatch(committedCatalog, pinnedState)) {
				prepared?.rollback()
				continue
			}

			let committedState = pinnedState
			if (!runtimeStateEqual(pinnedState.state, nextState)) {
				try {
					committedState = await this.runtimeState.commitVersioned(pinnedState.revision, nextState)
				} catch (error) {
					prepared?.rollback()
					if (error instanceof RuntimeStateRevisionConflictError) continue
					throw new RuntimeStatePersistenceError(error)
				}
			}

			if (
				this.catalog !== committedCatalog ||
				this.runtimeState.versionedSnapshot().revision !== committedState.revision
			) {
				prepared?.rollback()
				continue
			}

			let core: PluginApplyReport<TSummary>['core']
			let graphPublished = false
			const publishGraph = (): void => {
				if (graphPublished) return
				graphPublished = true
				this.catalog = proposedCatalog
				this.definitionRoles = preparedDefinitionRoles
				this.applied = plan.applied
				this.reconciliation = plan.blocked
			}
			if (prepared) {
				// Core invokes this callback synchronously immediately after graph confirmation and
				// before any teardown/start await. Readers therefore cannot observe new Core graph
				// state with an old route catalog.
				const summary = await prepared.commit({ onGraphCommitted: publishGraph })
				publishGraph()
				core = Object.freeze({ status: 'committed' as const, summary })
			} else {
				publishGraph()
				core = Object.freeze({ status: 'unchanged' as const })
			}
			return Object.freeze({
				catalogRevision: proposedCatalog.revision,
				runtimeStateRevision: committedState.revision,
				reconciliation: plan.blocked,
				core,
			})
		}
	}

	private async applyRestartOnly(
		reason: string,
		restartNodes: readonly PluginNodeAddress[],
	): Promise<PluginApplyReport<TSummary>> {
		for (;;) {
			const committedCatalog = this.catalog
			const pinnedState = this.runtimeState.versionedSnapshot()
			const operations: CorePluginOperation[] = []
			const seen = new Set<string>()
			for (const address of restartNodes) {
				const key = pluginNodeKey(address)
				if (seen.has(key)) continue
				seen.add(key)
				if (!this.applied.nodes.has(key)) throw new PluginRestartUnavailableError(address)
				operations.push({ type: 'restart-node', address, cascadeDependents: true })
			}

			const prepared = await this.prepareCore(reason, operations)
			if (!this.revisionsMatch(committedCatalog, pinnedState)) {
				prepared?.rollback()
				continue
			}

			if (!prepared) {
				return Object.freeze({
					catalogRevision: committedCatalog.revision,
					runtimeStateRevision: pinnedState.revision,
					reconciliation: this.reconciliation,
					core: Object.freeze({ status: 'unchanged' as const }),
				})
			}
			const summary = await prepared.commit({ onGraphCommitted: NOOP_GRAPH_COMMIT })
			return Object.freeze({
				catalogRevision: committedCatalog.revision,
				runtimeStateRevision: pinnedState.revision,
				reconciliation: this.reconciliation,
				core: Object.freeze({ status: 'committed' as const, summary }),
			})
		}
	}

	private async prepareCore(
		reason: string,
		operations: readonly CorePluginOperation[],
	): Promise<CorePluginPreparedUpdate<TSummary> | undefined> {
		if (operations.length === 0) return undefined
		const draft = this.core.beginUpdate({ reason })
		try {
			for (const operation of operations) applyCoreOperation(draft, operation)
			return await draft.prepare()
		} catch (error) {
			draft.rollback()
			throw error
		}
	}

	private revisionsMatch(
		catalog: PluginRouteCatalogSnapshot,
		state: RuntimeStateVersionedSnapshot,
	): boolean {
		return (
			this.catalog === catalog &&
			this.catalog.revision === catalog.revision &&
			this.runtimeState.versionedSnapshot().revision === state.revision
		)
	}

	private assertCatalogRevision(
		current: PluginRouteCatalogSnapshot,
		next: PluginRouteCatalogSnapshot,
	): void {
		if (next === current) return
		if (next.revision > current.revision) return
		throw new Error(
			`[runtime:reconciliation] catalog revision must advance beyond ${current.revision}`,
		)
	}
}

const NOOP_GRAPH_COMMIT = (): void => undefined

function pluginNodeKey(address: PluginNodeAddress): string {
	return pluginNodeIndexKey(address)
}

function applyCoreOperation<TSummary>(
	draft: CorePluginUpdateDraft<TSummary>,
	operation: CorePluginOperation,
): void {
	switch (operation.type) {
		case 'materialize-node':
			draft.materializeNode(operation.address, operation.candidate)
			return
		case 'dematerialize-node':
			draft.dematerializeNode(operation.address, {
				cascadeDependents: operation.cascadeDependents,
			})
			return
		case 'restart-node':
			draft.restartNode(operation.address, {
				cascadeDependents: operation.cascadeDependents,
			})
			return
		case 'replace-definition':
			draft.replaceDefinition(operation.address, operation.candidate, {
				cascadeDependents: operation.cascadeDependents,
			})
			return
		case 'set-provider-default':
			draft.setProviderDefault(operation.token, operation.provider)
			return
		case 'set-dependency-override':
			draft.setDependencyOverride(operation.consumer, operation.requirement, operation.provider)
	}
}
