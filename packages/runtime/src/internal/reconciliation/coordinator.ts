import {
	formatPluginNodeReference,
	pluginDefinitionIndexKey,
	pluginNodeIndexKey,
	type CommitSummary,
	type PluginDefinitionAddress,
	type PluginNodeAddress,
} from '@pluxel/core'
import {
	CorePluginGraphVerificationError,
	type ConcretePluginDefinitionCandidate,
} from '@pluxel/core/internal'
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
	type PluginSessionIntent,
	type PluginReconciliationIssue,
	type RuntimePluginDesiredControl,
	type RuntimePluginSessionEntry,
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
	readCommittedDependencyAdjacency(): CorePluginDependencyAdjacency
	isRunning(address: PluginNodeAddress): boolean
}

export type CorePluginDependencyAdjacencyEdge = Readonly<{
	consumer: PluginNodeAddress
	provider: PluginNodeAddress
}>

export type CorePluginDependencyAdjacency = Readonly<{
	nodes: readonly PluginNodeAddress[]
	required: readonly CorePluginDependencyAdjacencyEdge[]
	optional: readonly CorePluginDependencyAdjacencyEdge[]
}>

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

	constructor(
		public readonly issues: readonly PluginReconciliationIssue[],
		cause?: unknown,
	) {
		super('[runtime:reconciliation] update would invalidate committed Plugin graph policy', {
			cause,
		})
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

export class PluginStartUnavailableError extends Error {
	public readonly code = 'start_unavailable' as const
	public readonly state = 'unchanged' as const

	constructor(public readonly address: PluginNodeAddress) {
		super(
			`[runtime:reconciliation] cannot start an unavailable Plugin node: ${formatPluginNodeReference(address)}`,
		)
		this.name = 'PluginStartUnavailableError'
	}
}

export type RuntimePluginGraphUpdate = Readonly<{
	/** Activates prevalidated route resources synchronously after catalog acceptance, before new-generation startup. */
	onGraphCommitted?: () => void
	reason?: string
	catalog?: PluginRouteCatalogSnapshot
	statePatch?: RuntimeStatePatch
	/** Cold boot has no last-known-good catalog and therefore projects structural issues as blocked. */
	mode?: 'cold-boot' | 'live'
	sessionPatch?: readonly Readonly<{
		address: PluginNodeAddress
		intent: PluginSessionIntent
	}>[]
	lifecycleCommands?: readonly Readonly<{
		address: PluginNodeAddress
		desiredState: 'running' | 'stopped'
	}>[]
	retryStartNodes?: readonly PluginNodeAddress[]
	restartNodes?: readonly PluginNodeAddress[]
}>

export interface RuntimePluginGraphExclusiveSession<TSummary = unknown> {
	runtimeStateSnapshot(): RuntimeStateSnapshot
	validateRuntimeStatePatch(patch: RuntimeStatePatch): void
	report(): PluginApplyReport<TSummary>
	update(update: RuntimePluginGraphUpdate): Promise<PluginApplyReport<TSummary>>
}

/** Fixed process-local facts captured after all earlier graph transactions have settled. */
export type RuntimePluginGraphCommittedView = Readonly<{
	catalog: PluginRouteCatalogSnapshot
	runtimeState: RuntimeStateVersionedSnapshot
	reconciliation: readonly PluginReconciliationIssue[]
	sessionIntents: ReadonlyMap<string, RuntimePluginSessionEntry>
	desiredControl: ReadonlyMap<string, RuntimePluginDesiredControl>
	applied: AppliedPluginGraphSnapshot
	coreAdjacency: CorePluginDependencyAdjacency
	runningNodes: readonly PluginNodeAddress[]
}>

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
	private sessionIntents: ReadonlyMap<string, RuntimePluginSessionEntry> = new Map()
	private desiredControl: ReadonlyMap<string, RuntimePluginDesiredControl> = new Map()
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

	sessionIntentsSnapshot(): ReadonlyMap<string, RuntimePluginSessionEntry> {
		return this.sessionIntents
	}

	desiredControlSnapshot(): ReadonlyMap<string, RuntimePluginDesiredControl> {
		return this.desiredControl
	}

	coreDependencyAdjacencySnapshot(): CorePluginDependencyAdjacency {
		return this.core.readCommittedDependencyAdjacency()
	}

	runningNodesSnapshot(): readonly PluginNodeAddress[] {
		return Object.freeze(
			this.core
				.readCommittedDependencyAdjacency()
				.nodes.filter((address) => this.core.isRunning(address)),
		)
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
				...(update.sessionPatch ? { sessionPatch: Object.freeze([...update.sessionPatch]) } : {}),
				...(update.lifecycleCommands
					? { lifecycleCommands: Object.freeze([...update.lifecycleCommands]) }
					: {}),
				...(update.retryStartNodes
					? { retryStartNodes: Object.freeze([...update.retryStartNodes]) }
					: {}),
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

	startNode(
		address: PluginNodeAddress,
		reason = 'plugin-start',
	): Promise<PluginApplyReport<TSummary>> {
		return this.enqueue({
			reason,
			mode: 'live',
			lifecycleCommands: Object.freeze([{ address, desiredState: 'running' as const }]),
			retryStartNodes: Object.freeze([address]),
		})
	}

	stopNode(
		address: PluginNodeAddress,
		reason = 'plugin-stop',
	): Promise<PluginApplyReport<TSummary>> {
		return this.enqueue({
			reason,
			mode: 'live',
			lifecycleCommands: Object.freeze([{ address, desiredState: 'stopped' as const }]),
		})
	}

	/**
	 * Runs one synchronous read after all previously queued graph transactions have settled.
	 * The callback participates in the same queue so a later mutation cannot interleave while
	 * process-local Core and Runtime facts are being projected.
	 */
	readCommitted<T>(read: (view: RuntimePluginGraphCommittedView) => T): Promise<T> {
		if (this.disposed) {
			return Promise.reject(new Error('[runtime:reconciliation] coordinator is disposed'))
		}
		const execute = this.tail.then(async () => {
			await this.runtimeState.ready
			const coreAdjacency = this.core.readCommittedDependencyAdjacency()
			const runningNodes = Object.freeze(
				coreAdjacency.nodes.filter((address) => this.core.isRunning(address)),
			)
			const view: RuntimePluginGraphCommittedView = Object.freeze({
				catalog: this.catalog,
				runtimeState: this.runtimeState.versionedSnapshot(),
				reconciliation: this.reconciliation,
				sessionIntents: this.sessionIntents,
				desiredControl: this.desiredControl,
				applied: this.applied,
				coreAdjacency,
				runningNodes,
			})
			const value = read(view)
			if (isPromiseLike(value)) {
				void Promise.resolve(value).catch((): undefined => undefined)
				throw new TypeError(
					'[runtime:reconciliation] readCommitted callback must return synchronously',
				)
			}
			return value
		})
		this.tail = execute.then(
			(): void => undefined,
			(): void => undefined,
		)
		return execute
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
				report: () => this.currentReport(),
				update: (update: RuntimePluginGraphUpdate) =>
					this.applyUpdate(
						Object.freeze({
							...update,
							reason: update.reason ?? reason,
							...(update.sessionPatch
								? { sessionPatch: Object.freeze([...update.sessionPatch]) }
								: {}),
							...(update.lifecycleCommands
								? { lifecycleCommands: Object.freeze([...update.lifecycleCommands]) }
								: {}),
							...(update.retryStartNodes
								? { retryStartNodes: Object.freeze([...update.retryStartNodes]) }
								: {}),
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

	private currentReport(): PluginApplyReport<TSummary> {
		const state = this.runtimeState.versionedSnapshot()
		return Object.freeze({
			catalogRevision: this.catalog.revision,
			runtimeStateRevision: state.revision,
			reconciliation: this.reconciliation,
			core: Object.freeze({ status: 'unchanged' as const }),
		})
	}

	private async applyUpdate(
		update: QueuedRuntimePluginGraphUpdate,
	): Promise<PluginApplyReport<TSummary>> {
		await this.runtimeState.ready
		if (
			!update.catalog &&
			!update.statePatch &&
			!update.sessionPatch &&
			!update.lifecycleCommands &&
			!update.retryStartNodes &&
			update.restartNodes !== undefined
		) {
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
			assertLifecycleCommandAdmission(proposedCatalog, prospectiveState, update.lifecycleCommands)
			const baseSession =
				update.mode === 'cold-boot'
					? new Map<string, RuntimePluginSessionEntry>()
					: this.sessionIntents
			const rebasedSession =
				update.mode === 'cold-boot'
					? baseSession
					: update.statePatch?.operations.some((operation) => operation.type === 'set-auto-start')
						? rebaseSessionForPolicyPatch(
								baseSession,
								this.desiredControl,
								pinnedState.state,
								prospectiveState,
							)
						: baseSession
			const commandedSession = applyCanonicalLifecycleCommands(
				applySessionPatch(rebasedSession, update.sessionPatch),
				proposedCatalog,
				prospectiveState,
				update.lifecycleCommands,
			)
			const prospectiveSession = cleanupRemovedSessionIntents(commandedSession, update.statePatch)
			const initialPlan = reconcilePluginGraph({
				catalog: proposedCatalog,
				runtimeState: prospectiveState,
				runtimeStateRevision: pinnedState.revision,
				sessionIntents: prospectiveSession,
				applied: this.applied,
			})
			const nextState = applyRuntimeStatePatch(prospectiveState, initialPlan.statePatch)
			const plan = initialPlan.statePatch
				? reconcilePluginGraph({
						catalog: proposedCatalog,
						runtimeState: nextState,
						runtimeStateRevision: pinnedState.revision,
						sessionIntents: prospectiveSession,
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
			for (const address of update.retryStartNodes ?? []) {
				const key = pluginNodeKey(address)
				if (
					!plan.applied.nodes.has(key) ||
					this.core.isRunning(address) ||
					operations.some(
						(operation) =>
							operation.type === 'materialize-node' && pluginNodeKey(operation.address) === key,
					)
				) {
					continue
				}
				operations.push({ type: 'restart-node', address, cascadeDependents: true })
			}
			for (const address of update.restartNodes ?? []) {
				if (!plan.applied.nodes.has(pluginNodeKey(address)) || !this.core.isRunning(address)) {
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
				this.sessionIntents = prospectiveSession
				this.desiredControl = plan.desiredControl
				this.applied = plan.applied
				this.reconciliation = plan.blocked
				update.onGraphCommitted?.()
			}
			if (prepared) {
				// Core invokes this callback synchronously immediately after graph confirmation and
				// after old-generation teardown and before new-generation startup. Readers cannot observe new Core graph
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
				if (!this.applied.nodes.has(key) || !this.core.isRunning(address)) {
					throw new PluginRestartUnavailableError(address)
				}
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
			if (error instanceof CorePluginGraphVerificationError) {
				throw new PluginGraphRejectedError(Object.freeze([]), error)
			}
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

function assertLifecycleCommandAdmission(
	catalog: PluginRouteCatalogSnapshot,
	state: RuntimeStateSnapshot,
	commands:
		| readonly Readonly<{
				address: PluginNodeAddress
				desiredState: 'running' | 'stopped'
		  }>[]
		| undefined,
): void {
	if (!commands || commands.length === 0) return
	const forkNodeKeys = new Set<string>()
	for (const family of state.forks) {
		for (const forkId of family.forkIds) {
			forkNodeKeys.add(
				pluginNodeIndexKey({ definition: family.definition, variant: 'fork', forkId }),
			)
		}
	}
	for (const command of commands) {
		if (command.desiredState === 'stopped') continue
		if (isPluginNodeAvailable(catalog, forkNodeKeys, command.address)) continue
		throw new PluginStartUnavailableError(command.address)
	}
}

function isPluginNodeAvailable(
	catalog: PluginRouteCatalogSnapshot,
	forkNodeKeys: ReadonlySet<string>,
	address: PluginNodeAddress,
): boolean {
	const definition = catalog.byDefinition.get(pluginDefinitionIndexKey(address.definition))
	if (!definition) return false
	if (address.variant === 'default') return true
	if (!definition.candidate.declaration.forkable) return false
	return forkNodeKeys.has(pluginNodeIndexKey(address))
}

function applySessionPatch(
	current: ReadonlyMap<string, RuntimePluginSessionEntry>,
	patch:
		| readonly Readonly<{ address: PluginNodeAddress; intent: PluginSessionIntent }>[]
		| undefined,
): ReadonlyMap<string, RuntimePluginSessionEntry> {
	if (!patch || patch.length === 0) return current
	const next = new Map(current)
	for (const operation of patch) {
		const key = pluginNodeKey(operation.address)
		if (operation.intent === 'inherit') next.delete(key)
		else next.set(key, Object.freeze({ address: operation.address, intent: operation.intent }))
	}
	return next
}

function applyCanonicalLifecycleCommands(
	current: ReadonlyMap<string, RuntimePluginSessionEntry>,
	catalog: PluginRouteCatalogSnapshot,
	state: RuntimeStateSnapshot,
	commands:
		| readonly Readonly<{
				address: PluginNodeAddress
				desiredState: 'running' | 'stopped'
		  }>[]
		| undefined,
): ReadonlyMap<string, RuntimePluginSessionEntry> {
	if (!commands || commands.length === 0) return current
	const next = new Map(current)
	for (const command of commands) {
		const key = pluginNodeKey(command.address)
		next.delete(key)
		const inherited = reconcilePluginGraph({
			catalog,
			runtimeState: state,
			runtimeStateRevision: 0,
			sessionIntents: next,
		})
		const inheritedState = inherited.desiredControl.has(key) ? 'running' : 'stopped'
		if (command.desiredState === inheritedState) {
			continue
		}
		next.set(
			key,
			Object.freeze({
				address: command.address,
				intent: command.desiredState === 'running' ? ('run' as const) : ('stop' as const),
			}),
		)
	}
	return next
}

/** Keeps the already-requested process state stable while durable cold-boot policy changes. */
function rebaseSessionForPolicyPatch(
	current: ReadonlyMap<string, RuntimePluginSessionEntry>,
	desired: ReadonlyMap<string, RuntimePluginDesiredControl>,
	before: RuntimeStateSnapshot,
	after: RuntimeStateSnapshot,
): ReadonlyMap<string, RuntimePluginSessionEntry> {
	const beforeByKey = new Map(before.autoStart.map((address) => [pluginNodeKey(address), address]))
	const afterByKey = new Map(after.autoStart.map((address) => [pluginNodeKey(address), address]))
	const changed = new Set([...beforeByKey.keys(), ...afterByKey.keys()])
	const next = new Map(current)
	let didChange = false
	for (const key of changed) {
		const wasAutoStart = beforeByKey.has(key)
		const autoStart = afterByKey.has(key)
		if (wasAutoStart === autoStart) continue
		didChange = true
		const keepRunning = desired.has(key)
		if (keepRunning === autoStart) {
			next.delete(key)
			continue
		}
		const address = afterByKey.get(key) ?? beforeByKey.get(key)
		if (!address) throw new Error('[runtime:reconciliation] changed auto-start node is missing')
		next.set(
			key,
			Object.freeze({
				address,
				intent: keepRunning ? ('run' as const) : ('stop' as const),
			}),
		)
	}
	return didChange ? next : current
}

function cleanupRemovedSessionIntents(
	current: ReadonlyMap<string, RuntimePluginSessionEntry>,
	patch: RuntimeStatePatch | undefined,
): ReadonlyMap<string, RuntimePluginSessionEntry> {
	if (
		!patch?.operations.some(
			(operation) => operation.type === 'remove-node-policy' || operation.type === 'remove-fork',
		)
	) {
		return current
	}
	const next = new Map(current)
	for (const operation of patch.operations) {
		if (operation.type === 'remove-node-policy') {
			next.delete(pluginNodeKey(operation.node))
		} else if (operation.type === 'remove-fork') {
			next.delete(
				pluginNodeKey({
					definition: operation.definition,
					variant: 'fork',
					forkId: operation.forkId,
				}),
			)
		}
	}
	return next
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return (
		value !== null &&
		(typeof value === 'object' || typeof value === 'function') &&
		typeof (value as { then?: unknown }).then === 'function'
	)
}

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
