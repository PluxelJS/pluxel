import type { Context as PluxelContext } from '../../context/Context'
import { pinOwnerContext } from '../../context/owner-view'
import { createGenerationContext } from '../../context/context-factory'
import { createErr, createOk } from 'option-t/plain_result'
import { requireConfigService } from '../../internal/config-service'
import type { BasePlugin } from '../composition/BasePlugin'
import { createCallerGenerationView } from '../composition/caller-view'
import type { PluginToken } from '../types'
import { computeInitPlan, type InitPlan, startPluginsTopo, stopPluginsTopo } from './commit'
import {
	pluginDefinitionAddressOf,
	type ConcretePluginDefinitionCandidate,
	type PluginRef,
} from './definition'
import {
	formatPluginNodeReference,
	isPluginNodeSlot,
	parsePluginDefinitionAddress,
	type PluginDefinitionAddress,
	type PluginDefinitionSlot,
	type PluginNodeAddress,
	type PluginNodeSlot,
} from './identity'
import {
	PluginDefinitions,
	PluginGenerationConstructionError,
	requirePluginGenerationInfo,
	type PluginGraph,
	type PluginRuntime,
} from './PluginDefinitions'
import {
	collectRuntimeEvictions,
	createCommitExecutionPlan,
	createPluginCommitChanges,
	createRuntimeUpdateSummary,
	EMPTY_DELTA,
	EMPTY_PLUGIN_COMMIT_CHANGES,
	isCommitExecutionPlanEmpty,
	type CommitExecutionDelta,
	type CommitExecutionPlan,
	type CommitSummary,
} from './plugin-service/CommitPlan'
import { assignValidatedPluginConfig } from './plugin-service/ConfigInjection'
import { DependentClosureCollector } from './plugin-service/DependentClosureCollector'
import { InstanceWatcherRegistry } from './plugin-service/InstanceWatcherRegistry'
import { LifecycleManager } from './plugin-service/LifecycleManager'
import {
	collectPluginLifecycleNotStarted,
	createLifecycleReport,
	EMPTY_LIFECYCLE_REPORT,
	errorMessage,
	finalizeLifecycleReport,
	observeLifecycleReport,
	PLUGIN_LIFECYCLE_ISSUE_KIND,
	recordLifecycleIssue,
	serializeLifecycleError,
	type MutableLifecycleReport,
} from './plugin-service/LifecycleReport'
import {
	PluginRuntimeUpdateTransaction,
	type CascadeOptions,
	type PreparedRuntimeUpdateCommitOptions,
	type PreparedRuntimeUpdate,
	type ReplaceDefinitionOptions,
	type RuntimeUpdateCommitMeta,
	type RuntimeUpdateController,
	type RuntimeUpdateOptions,
	type RuntimeUpdateTransaction,
} from './plugin-service/RuntimeUpdateTransaction'

export type {
	CommitSummary,
	PluginCommitChanges,
	PluginReplacement,
	RuntimeUpdateCommitSummary,
} from './plugin-service/CommitPlan'

export type PluginServiceConfig = {
	startTimeoutMs?: number
	drainTimeoutMs?: number
	startConcurrency?: number
	stopConcurrency?: number
}

type RuntimeUpdateCommitResult =
	| { ok: true; val: { graph: PluginGraph; delta: CommitExecutionDelta } }
	| { ok: false; err: unknown }

type RuntimeUpdateCheckpoint = {
	pendingStart: Set<PluginNodeSlot>
	pendingRestart: Set<PluginNodeSlot>
}

type PreparedDefinitionBuild = Extract<ReturnType<PluginDefinitions['build']>, { ok: true }>['val']

const DEFAULT_START_TIMEOUT_MS = 1_500
const DEFAULT_DRAIN_TIMEOUT_MS = 3_000
const DEFAULT_START_CONCURRENCY = 8
const DEFAULT_STOP_CONCURRENCY = 1
const RUNTIME_UPDATE_ALREADY_ACTIVE_MESSAGE =
	'Cannot begin a Core Plugin update while another update is active'
const RUNTIME_UPDATE_PENDING_DRAFT_MESSAGE =
	'Cannot begin a Core Plugin update while a registry draft is pending'
const STALE_PREPARED_UPDATE_MESSAGE = 'Prepared Core Plugin update is stale'

function ensureError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error), { cause: error })
}

export class PluginService {
	private readonly definitions: PluginDefinitions
	private _commitLock: Promise<unknown> = Promise.resolve()
	private readonly startTimeoutMs: number
	private readonly drainTimeoutMs: number
	private readonly startConcurrency: number
	private readonly stopConcurrency: number
	private _lastCommit?: CommitSummary
	private _activeGraph?: PluginGraph
	private _activeRuntime?: PluginRuntime
	private readonly commitListeners = new Set<(summary: CommitSummary) => void>()
	private _pendingStart = new Set<PluginNodeSlot>()
	private _pendingRestart = new Set<PluginNodeSlot>()
	private activeRuntimeUpdate?: RuntimeUpdateTransaction<RuntimeUpdateCommitResult>
	private readonly runtimeUpdateCheckpoints = new WeakMap<
		RuntimeUpdateTransaction<RuntimeUpdateCommitResult>,
		RuntimeUpdateCheckpoint
	>()
	private commitRevision = 0
	private order = 0
	private readonly lifecycleManager: LifecycleManager
	private readonly watcherRegistry: InstanceWatcherRegistry
	private readonly dependentClosure: DependentClosureCollector

	private readonly runtimeUpdateController: RuntimeUpdateController<RuntimeUpdateCommitResult> = {
		materializeNode: (address, candidate) => this.materializeNode(address, candidate),
		dematerializeNode: (address, options) => this.dematerializeNode(address, options),
		restartNode: (address, options) => this.restartNode(address, options),
		replaceDefinition: (address, candidate, options) =>
			this.replaceDefinition(address, candidate, options),
		setProviderDefault: (token, provider) => this.setProviderDefault(token, provider),
		setDependencyOverride: (consumer, requirement, provider) =>
			this.setDependencyOverride(consumer, requirement, provider),
		prepareDraft: (tx, meta) => this.prepareRuntimeUpdate(tx, meta),
		rollbackDraft: (tx) => this.rollbackRuntimeUpdate(tx),
	}

	constructor(
		public readonly ctx: PluxelContext,
		config: PluginServiceConfig = {},
	) {
		pinOwnerContext(this, ctx)
		this.startTimeoutMs = config.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS
		this.drainTimeoutMs = config.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS
		this.startConcurrency = config.startConcurrency ?? DEFAULT_START_CONCURRENCY
		this.stopConcurrency = config.stopConcurrency ?? DEFAULT_STOP_CONCURRENCY
		this.definitions = new PluginDefinitions(() => this.createPluginContext())
		this.lifecycleManager = new LifecycleManager(
			this.ctx,
			this.definitions.slots,
			this.startTimeoutMs,
			this.drainTimeoutMs,
		)
		this.dependentClosure = new DependentClosureCollector((graph, address) =>
			this.resolveGraphKey(graph, address),
		)
		this.watcherRegistry = new InstanceWatcherRegistry(
			(graph, address) => this.resolveGraphKey(graph, address),
			(node) => this.getRunningRuntimeInstance(node),
			(error) => this.ctx.logger.error('Plugin instance watcher error', { error }),
		)
	}

	get graph(): PluginGraph {
		return this.definitions.lastGraph
	}

	get lastCommit(): CommitSummary | undefined {
		return this._lastCommit
	}

	beginUpdate(
		options: RuntimeUpdateOptions = {},
	): RuntimeUpdateTransaction<RuntimeUpdateCommitResult> {
		if (this.activeRuntimeUpdate) throw new Error(RUNTIME_UPDATE_ALREADY_ACTIVE_MESSAGE)
		if (this.definitions.hasPendingChanges()) throw new Error(RUNTIME_UPDATE_PENDING_DRAFT_MESSAGE)
		const tx = new PluginRuntimeUpdateTransaction(this.runtimeUpdateController, options)
		this.runtimeUpdateCheckpoints.set(tx, {
			pendingStart: new Set(this._pendingStart),
			pendingRestart: new Set(this._pendingRestart),
		})
		this.activeRuntimeUpdate = tx
		return tx
	}

	isMaterialized(input: PluginNodeAddress): boolean {
		return this.definitions.resolveCommittedNode(input) !== undefined
	}

	isRunning(input: PluginNodeAddress | PluginNodeSlot | PluginToken): boolean {
		const node = this.resolveGraphKey(this._activeGraph ?? this.graph, input)
		return Boolean(node && this.lifecycleManager.isRunning(this.getRuntimeInstance(node)))
	}

	getInstance<T extends PluginToken>(input: T): InstanceType<T> | undefined
	getInstance(input: PluginNodeAddress | PluginNodeSlot): BasePlugin | undefined
	getInstance(input: PluginNodeAddress | PluginNodeSlot | PluginToken): BasePlugin | undefined {
		const node = this.resolveGraphKey(this._activeGraph ?? this.graph, input)
		return this.getRunningRuntimeInstance(node)
	}

	resolvedDependencies(input: PluginNodeAddress): readonly PluginNodeAddress[] {
		const graph = this._activeGraph ?? this.graph
		const node = this.resolveGraphKey(graph, input)
		if (!node) return Object.freeze([])
		const slot = graph.slotOf(node)
		if (slot === undefined) return Object.freeze([])
		return Object.freeze(
			graph
				.depSlotsOf(slot)
				.map((dependency) => graph.keyOf(dependency))
				.filter(isPluginNodeSlot)
				.map((dependency) => this.definitions.slots.nodeAddress(dependency)),
		)
	}

	resolvePluginNode(
		input: PluginNodeAddress | PluginNodeSlot | PluginToken,
	): PluginNodeSlot | undefined {
		return this.resolveGraphKey(this._activeGraph ?? this.graph, input)
	}

	internNodeAddress(address: PluginNodeAddress): PluginNodeSlot {
		return this.definitions.internNode(address)
	}

	internDefinitionAddress(address: PluginDefinitionAddress): PluginDefinitionSlot {
		return this.definitions.internDefinition(address)
	}

	definitionAddressOf(slot: PluginDefinitionSlot): PluginDefinitionAddress {
		return this.definitions.slots.definitionAddress(slot)
	}

	nodeAddressOf(slot: PluginNodeSlot): PluginNodeAddress {
		return this.definitions.slots.nodeAddress(slot)
	}

	resolvePluginRef<T>(ref: PluginRef<T>, consumer: PluxelContext): T | undefined {
		const graph = this._activeGraph ?? this.graph
		const definition = this.definitions.lookupDefinition(ref.definition)
		if (!definition) return undefined
		const resolved = graph.resolve(definition)
		if (!isPluginNodeSlot(resolved) || resolved.variant !== 'default') return undefined
		const node = this.definitions.committedNodeRecord(resolved)
		if (node?.definition.slot !== definition) return undefined
		const provider = this.getRunningRuntimeInstance(resolved)
		return provider ? (createCallerGenerationView(provider, consumer) as T) : undefined
	}

	/** @internal Resolve an author constructor token without making it a graph key. */
	resolveAuthorDependency<T extends BasePlugin>(
		token: PluginToken,
		consumer: PluxelContext,
	): T | undefined {
		const definition = this.definitions.lookupDefinition(pluginDefinitionAddressOf(token))
		if (!definition) return undefined
		const graph = this._activeGraph ?? this.graph
		const resolved = graph.resolve(definition)
		if (!isPluginNodeSlot(resolved)) return undefined
		const provider = this.getRunningRuntimeInstance(resolved)
		return provider ? (createCallerGenerationView(provider, consumer) as T) : undefined
	}

	watchInstance(
		input: PluginNodeAddress | PluginNodeSlot | PluginToken,
		callback: (instance: BasePlugin | undefined) => void,
	): () => void {
		return isPluginNodeSlot(input)
			? this.watcherRegistry.watch(this._activeGraph ?? this.graph, input, callback)
			: typeof input === 'function'
				? this.watcherRegistry.watch(this._activeGraph ?? this.graph, input, callback)
				: this.watcherRegistry.watch(this._activeGraph ?? this.graph, input, callback)
	}

	subscribeCommitted(listener: (summary: CommitSummary) => void): () => void {
		this.commitListeners.add(listener)
		return () => this.commitListeners.delete(listener)
	}

	afterCurrentCommit<T>(run: () => T | Promise<T>): Promise<T> {
		return this._commitLock.then(run)
	}

	resetDraft(): void {
		if (this.activeRuntimeUpdate) this.activeRuntimeUpdate.rollback()
		else this.definitions.resetDraft()
	}

	private materializeNode(
		address: PluginNodeAddress,
		candidate: ConcretePluginDefinitionCandidate,
	): void {
		const node = this.definitions.materializeNode(address, candidate)
		this._pendingStart.add(node)
	}

	private dematerializeNode(address: PluginNodeAddress, options?: CascadeOptions): void {
		const node = this.definitions.resolvePlanningNode(address)
		if (!node) return
		const targets =
			options?.cascadeDependents === false
				? new Set([node])
				: this.definitions.collectPlanningCascadeTargets([node])
		for (const target of targets) this.definitions.dematerializeNode(this.nodeAddressOf(target))
		this.clearPendingOperations(targets)
	}

	private restartNode(address: PluginNodeAddress, options?: CascadeOptions): void {
		const node = this.definitions.restartNode(address)
		const targets = this.collectPlanningCascadeTargets([node], options?.cascadeDependents ?? true)
		for (const target of targets) this._pendingRestart.add(target)
	}

	private replaceDefinition(
		address: PluginDefinitionAddress,
		candidate: ConcretePluginDefinitionCandidate,
		options?: ReplaceDefinitionOptions,
	): void {
		const canonicalAddress = parsePluginDefinitionAddress(address)
		const roots = this.definitions.materializedNodes(canonicalAddress)
		const targets = this.collectPlanningCascadeTargets(roots, options?.cascadeDependents ?? true)
		this.definitions.replaceDefinition(canonicalAddress, candidate)
		for (const target of targets) this._pendingRestart.add(target)
	}

	private setProviderDefault(
		tokenAddress: PluginDefinitionAddress,
		provider: PluginNodeAddress | null,
	): void {
		const token = this.definitions.lookupDefinition(tokenAddress)
		if (!token && provider === null) return
		const graph = this.currentPlanningGraph()
		const consumers = token ? (graph?.consumers(token).filter(isPluginNodeSlot) ?? []) : []
		this.definitions.setProviderDefault(tokenAddress, provider)
		if (consumers.length === 0) return
		for (const target of this.collectPlanningCascadeTargets(consumers, true)) {
			this._pendingRestart.add(target)
		}
	}

	private setDependencyOverride(
		consumerAddress: PluginNodeAddress,
		requirement: PluginDefinitionAddress,
		provider: PluginNodeAddress | null,
	): void {
		const consumer = this.definitions.resolvePlanningNode(consumerAddress)
		if (!consumer) throw new Error('[pluxel/core] Dependency override consumer is absent')
		this.definitions.setDependencyOverride(consumerAddress, requirement, provider)
		for (const target of this.collectPlanningCascadeTargets([consumer], true)) {
			this._pendingRestart.add(target)
		}
	}

	private prepareRuntimeUpdate(
		tx: RuntimeUpdateTransaction<RuntimeUpdateCommitResult>,
		meta: RuntimeUpdateCommitMeta,
	): PreparedRuntimeUpdate<RuntimeUpdateCommitResult> {
		if (this.activeRuntimeUpdate !== tx) throw new Error(STALE_PREPARED_UPDATE_MESSAGE)
		const action = this.definitions.build()
		if (!action.ok) {
			throw new Error(`Core Plugin graph verification failed:\n${action.err.err.format()}`, {
				cause: action.err.err,
			})
		}
		const expectedRevision = this.commitRevision
		let state: 'prepared' | 'committing' | 'closed' = 'prepared'
		return {
			reason: meta.reason,
			commit: (options?: PreparedRuntimeUpdateCommitOptions) => {
				if (state !== 'prepared') throw new Error('Prepared Core Plugin update is closed')
				state = 'committing'
				return this.enqueuePreparedCommit(action.val, meta, tx, expectedRevision, options).finally(
					() => {
						state = 'closed'
					},
				)
			},
			rollback: () => {
				if (state !== 'prepared') return
				state = 'closed'
				this.rollbackRuntimeUpdate(tx)
			},
		}
	}

	private enqueuePreparedCommit(
		action: PreparedDefinitionBuild,
		meta: RuntimeUpdateCommitMeta,
		tx: RuntimeUpdateTransaction<RuntimeUpdateCommitResult>,
		expectedRevision: number,
		options?: PreparedRuntimeUpdateCommitOptions,
	): Promise<RuntimeUpdateCommitResult> {
		const next = this._commitLock.then(async () => {
			if (this.commitRevision !== expectedRevision || this.activeRuntimeUpdate !== tx) {
				throw new Error(STALE_PREPARED_UPDATE_MESSAGE)
			}
			let pointOfNoReturn = false
			let graphCommitted = false
			const confirmGraph = () => {
				if (graphCommitted) return
				action.confirm()
				this.commitRevision += 1
				graphCommitted = true
				options?.onGraphCommitted?.()
			}
			try {
				const result = await this.executePreparedCommit(
					action,
					meta,
					() => {
						pointOfNoReturn = true
					},
					confirmGraph,
				)
				this.completeRuntimeUpdate(tx)
				return result
			} catch (caughtError) {
				let resultError = caughtError
				if (!pointOfNoReturn) {
					this.rollbackRuntimeUpdate(tx)
				} else {
					// Teardown has begun, so structural rollback is no longer valid. Force the
					// already-prepared graph to become fact, then leave every non-running node
					// eligible for a later reconciliation retry.
					try {
						confirmGraph()
					} catch (confirmError) {
						resultError = new AggregateError(
							[caughtError, confirmError],
							'Core Plugin update failed after teardown and graph confirmation also failed',
						)
					}
					this.definitions.resetDraft()
					this.recoverPendingStarts()
					this.completeRuntimeUpdate(tx)
				}
				return createErr(resultError)
			} finally {
				;(tx as PluginRuntimeUpdateTransaction<RuntimeUpdateCommitResult>).markCommitted()
			}
		})
		this._commitLock = next.catch((): undefined => undefined)
		return next.catch((error) => createErr(error))
	}

	private rollbackRuntimeUpdate(tx: RuntimeUpdateTransaction<RuntimeUpdateCommitResult>): void {
		if (this.activeRuntimeUpdate !== tx) return
		const checkpoint = this.runtimeUpdateCheckpoints.get(tx)
		this.definitions.resetDraft()
		if (checkpoint) {
			this._pendingStart = new Set(checkpoint.pendingStart)
			this._pendingRestart = new Set(checkpoint.pendingRestart)
		}
		this.completeRuntimeUpdate(tx)
	}

	private completeRuntimeUpdate(tx: RuntimeUpdateTransaction<RuntimeUpdateCommitResult>): void {
		this.runtimeUpdateCheckpoints.delete(tx)
		if (this.activeRuntimeUpdate === tx) this.activeRuntimeUpdate = undefined
	}

	private createPluginContext(): PluxelContext {
		return createGenerationContext(this.ctx.root, `${this.order++}`)
	}

	private resolveGraphKey(
		graph: PluginGraph | undefined,
		input: PluginNodeAddress | PluginNodeSlot | PluginToken,
	): PluginNodeSlot | undefined {
		if (typeof input === 'function') {
			const definition = this.definitions.lookupDefinition(pluginDefinitionAddressOf(input))
			if (!definition) return undefined
			const resolved = graph?.resolve(definition)
			if (isPluginNodeSlot(resolved)) return resolved
			return undefined
		}
		const node = isPluginNodeSlot(input) ? input : this.definitions.slots.lookupNode(input)
		if (!node) return undefined
		return !graph || graph.has(node) ? node : undefined
	}

	private currentPlanningGraph(): PluginGraph | undefined {
		if (this._activeGraph) return this._activeGraph
		return this.definitions.hasPendingChanges() ? undefined : this.graph
	}

	private collectPlanningCascadeTargets(
		nodes: Iterable<PluginNodeSlot>,
		cascadeDependents: boolean,
	): Set<PluginNodeSlot> {
		if (!cascadeDependents) return new Set(nodes)
		const graph = this.currentPlanningGraph()
		return graph
			? this.dependentClosure.collect(graph, nodes)
			: this.definitions.collectPlanningCascadeTargets(nodes)
	}

	private clearPendingOperations(nodes: Iterable<PluginNodeSlot>): void {
		for (const node of nodes) {
			this._pendingStart.delete(node)
			this._pendingRestart.delete(node)
		}
	}

	private activeRuntime(): PluginRuntime {
		return this._activeRuntime ?? this.definitions.runtime
	}

	private getRuntimeInstance(node: PluginNodeSlot | undefined): BasePlugin | undefined {
		return node ? (this.activeRuntime().peekByKey(node) as BasePlugin | undefined) : undefined
	}

	private getRunningRuntimeInstance(node: PluginNodeSlot | undefined): BasePlugin | undefined {
		const instance = this.getRuntimeInstance(node)
		return instance && this.lifecycleManager.isRunning(instance) ? instance : undefined
	}

	private async injectConfig(plugin: BasePlugin): Promise<number | null> {
		const info = requirePluginGenerationInfo(plugin.ctx)
		if (!info.config) return null
		const configService = requireConfigService(plugin.ctx)
		const value = await configService.ensureValidated(
			plugin.ctx.pluginInfo.nodeAddress,
			info.config,
			{ missingObjectDefault: {} },
		)
		assignValidatedPluginConfig(plugin, info.config, value)
		return configService.getConfigRevision(plugin.ctx.pluginInfo.nodeAddress)
	}

	private async stopPlugin(node: PluginNodeSlot, report: MutableLifecycleReport): Promise<void> {
		const plugin = this.getRuntimeInstance(node)
		if (!plugin) return
		const configOwner = requirePluginGenerationInfo(plugin.ctx).config
			? plugin.ctx.pluginInfo.nodeAddress
			: undefined
		try {
			const snapshot = await this.lifecycleManager.stopLifecycle(node, plugin)
			const context = snapshot?.context as { failedStep?: string; err?: unknown } | undefined
			if (context?.failedStep !== 'drain') return
			recordLifecycleIssue(report, {
				plugin: node,
				phase: 'drain',
				kind: PLUGIN_LIFECYCLE_ISSUE_KIND.DrainFailed,
				message: context.err
					? errorMessage(context.err)
					: `Plugin ${this.label(node)} failed to drain`,
				error: context.err ? serializeLifecycleError(context.err) : undefined,
			})
		} catch (error) {
			recordLifecycleIssue(report, {
				plugin: node,
				phase: 'drain',
				kind: PLUGIN_LIFECYCLE_ISSUE_KIND.DrainFailed,
				message: errorMessage(error),
				error: serializeLifecycleError(error),
			})
		} finally {
			if (configOwner) requireConfigService(this.ctx).clearConfigApplied(configOwner)
		}
	}

	private async applyTeardown(
		graph: PluginGraph | undefined,
		toStop: Set<number>,
		report: MutableLifecycleReport,
	): Promise<void> {
		if (!graph || toStop.size === 0) return
		await stopPluginsTopo(
			(slot) => graph.orderDependentSlotsOf(slot),
			toStop,
			async (slot) => {
				const node = graph.keyOf(slot)
				if (isPluginNodeSlot(node)) await this.stopPlugin(node, report)
			},
			{ concurrency: this.stopConcurrency },
		)
	}

	private async instantiateAndStart(
		runtime: PluginRuntime,
		node: PluginNodeSlot,
		report: MutableLifecycleReport,
	): Promise<boolean> {
		const instance = await this.resolveGeneration(runtime, node, report)
		if (!instance) return false
		const configRevision = await this.injectPluginConfig(runtime, node, instance, report)
		if (configRevision === undefined) return false
		const started = await this.startGeneration(runtime, node, instance, report)
		if (started && configRevision !== null) {
			requireConfigService(this.ctx).markConfigApplied(this.nodeAddressOf(node), configRevision)
		}
		return started
	}

	private recordDrainFailure(
		report: MutableLifecycleReport,
		node: PluginNodeSlot,
		error: unknown,
	): void {
		recordLifecycleIssue(report, {
			plugin: node,
			phase: 'drain',
			kind: PLUGIN_LIFECYCLE_ISSUE_KIND.DrainFailed,
			message: errorMessage(error),
			error: serializeLifecycleError(error),
		})
	}

	private async drainFailedGeneration(
		node: PluginNodeSlot,
		instance: BasePlugin,
		report: MutableLifecycleReport,
	): Promise<void> {
		try {
			const drainError = await this.lifecycleManager.drainUnstartedGeneration(node, instance)
			if (drainError !== undefined) this.recordDrainFailure(report, node, drainError)
		} catch (error) {
			this.recordDrainFailure(report, node, error)
		}
	}

	private async resolveGeneration(
		runtime: PluginRuntime,
		node: PluginNodeSlot,
		report: MutableLifecycleReport,
	): Promise<BasePlugin | undefined> {
		try {
			return runtime.ensureByKey(node) as BasePlugin
		} catch (error) {
			let constructionCleanupError: unknown
			if (error instanceof PluginGenerationConstructionError) {
				try {
					await error.cleanup
				} catch (cleanupError) {
					constructionCleanupError = cleanupError
				}
			}
			const err = ensureError(
				error instanceof PluginGenerationConstructionError ? error.cause : error,
			)
			recordLifecycleIssue(report, {
				plugin: node,
				phase: 'resolve',
				kind: PLUGIN_LIFECYCLE_ISSUE_KIND.ResolveFailed,
				message: err.message,
				error: serializeLifecycleError(err),
			})
			if (constructionCleanupError !== undefined) {
				this.recordDrainFailure(report, node, constructionCleanupError)
			}
			return undefined
		}
	}

	private async injectPluginConfig(
		runtime: PluginRuntime,
		node: PluginNodeSlot,
		instance: BasePlugin,
		report: MutableLifecycleReport,
	): Promise<number | null | undefined> {
		try {
			return await this.injectConfig(instance)
		} catch (error) {
			const err = ensureError(error)
			recordLifecycleIssue(report, {
				plugin: node,
				phase: 'config',
				kind: PLUGIN_LIFECYCLE_ISSUE_KIND.ConfigFailed,
				message: err.message,
				error: serializeLifecycleError(err),
			})
			await this.drainFailedGeneration(node, instance, report)
			runtime.delete(node)
			return undefined
		}
	}

	private async startGeneration(
		runtime: PluginRuntime,
		node: PluginNodeSlot,
		instance: BasePlugin,
		report: MutableLifecycleReport,
	): Promise<boolean> {
		try {
			const result = await this.lifecycleManager.startLifecycle(
				node,
				instance,
				requirePluginGenerationInfo(instance.ctx).startTimeoutMs,
				(error, phase) =>
					recordLifecycleIssue(report, {
						plugin: node,
						phase,
						kind:
							phase === 'drain'
								? PLUGIN_LIFECYCLE_ISSUE_KIND.DrainFailed
								: PLUGIN_LIFECYCLE_ISSUE_KIND.StartFailed,
						message: errorMessage(error),
						error: serializeLifecycleError(error),
					}),
			)
			if (result.ok === true) return true
			recordLifecycleIssue(report, {
				plugin: node,
				phase: 'start',
				kind: PLUGIN_LIFECYCLE_ISSUE_KIND.StartFailed,
				message: errorMessage(result.startError),
				error: serializeLifecycleError(result.startError),
			})
			if (result.drainError !== undefined) {
				this.recordDrainFailure(report, node, result.drainError)
			}
		} catch (error) {
			recordLifecycleIssue(report, {
				plugin: node,
				phase: 'start',
				kind: PLUGIN_LIFECYCLE_ISSUE_KIND.StartFailed,
				message: errorMessage(error),
				error: serializeLifecycleError(error),
			})
			await this.drainFailedGeneration(node, instance, report)
		}
		runtime.delete(node)
		return false
	}

	private startPlugins(
		runtime: PluginRuntime,
		graph: PluginGraph,
		plan: InitPlan<number>,
		report: MutableLifecycleReport,
	): Promise<Set<number>> {
		for (const slot of plan.leftovers) {
			const node = graph.keyOf(slot)
			if (!isPluginNodeSlot(node)) continue
			recordLifecycleIssue(report, {
				plugin: node,
				phase: 'dependency',
				kind: PLUGIN_LIFECYCLE_ISSUE_KIND.DependencyBlocked,
				message: `Plugin ${this.label(node)} could not be scheduled because its dependency graph is cyclic.`,
			})
		}
		return startPluginsTopo(
			plan,
			(slot) => {
				const node = graph.keyOf(slot)
				return isPluginNodeSlot(node)
					? this.instantiateAndStart(runtime, node, report)
					: Promise.resolve(false)
			},
			{
				concurrency: this.startConcurrency,
				blocks: (slot, dependency) =>
					graph.depSlotsOf(slot as number).includes(dependency as number),
				onDependencyBlocked: (slot, dependency) => {
					const node = graph.keyOf(slot as number)
					const blockedBy = graph.keyOf(dependency as number)
					if (!isPluginNodeSlot(node) || !isPluginNodeSlot(blockedBy)) return
					recordLifecycleIssue(report, {
						plugin: node,
						phase: 'dependency',
						kind: PLUGIN_LIFECYCLE_ISSUE_KIND.DependencyBlocked,
						blockedBy,
						message: `Plugin ${this.label(node)} was not started because dependency ${this.label(blockedBy)} failed.`,
					})
				},
			},
		)
	}

	private async startSlotSet(
		runtime: PluginRuntime,
		graph: PluginGraph,
		slots: Set<number>,
		report: MutableLifecycleReport,
	): Promise<Set<PluginNodeSlot>> {
		const failed = new Set<PluginNodeSlot>()
		if (slots.size === 0) return failed
		const plan = computeInitPlan(slots, (slot) => graph.orderDepSlotsOf(slot))
		for (const slot of await this.startPlugins(runtime, graph, plan, report)) {
			const node = graph.keyOf(slot)
			if (isPluginNodeSlot(node)) failed.add(node)
		}
		return failed
	}

	private isRunningInRuntime(runtime: PluginRuntime, node: PluginNodeSlot): boolean {
		return this.lifecycleManager.isRunning(runtime.peekByKey<BasePlugin>(node))
	}

	private expandPreStopAvailabilityClosure(
		plan: CommitExecutionPlan,
		oldGraph: PluginGraph,
		graph: PluginGraph,
		oldRuntime: PluginRuntime,
		oldRunning: Set<PluginNodeSlot>,
	): void {
		const roots: PluginNodeSlot[] = []
		for (const slot of plan.toStopSlots) {
			const node = oldGraph.keyOf(slot)
			if (!isPluginNodeSlot(node) || !this.isRunningInRuntime(oldRuntime, node)) continue
			oldRunning.add(node)
			for (const dependentSlot of oldGraph.orderDependentSlotsOf(slot)) {
				if (plan.toStopSlots.has(dependentSlot)) continue
				const dependent = oldGraph.keyOf(dependentSlot)
				if (isPluginNodeSlot(dependent)) roots.push(dependent)
			}
		}
		if (roots.length === 0) return
		for (const node of this.dependentClosure.collectOrdering(oldGraph, roots)) {
			if (!this.isRunningInRuntime(oldRuntime, node)) continue
			oldRunning.add(node)
			const oldSlot = oldGraph.slotOf(node)
			if (oldSlot !== undefined) {
				plan.toStop.add(node)
				plan.toStopSlots.add(oldSlot)
			}
			const nextSlot = graph.slotOf(node)
			if (nextSlot !== undefined) {
				plan.toStart.add(node)
				plan.toStartSlots.add(nextSlot)
			}
		}
	}

	private capturePostStartAvailabilityState(
		plan: CommitExecutionPlan,
		graph: PluginGraph,
		oldRuntime: PluginRuntime,
		oldRunning: Set<PluginNodeSlot>,
	): void {
		const roots: PluginNodeSlot[] = []
		for (const node of plan.toStart) {
			if (this.isRunningInRuntime(oldRuntime, node)) oldRunning.add(node)
			else {
				const slot = graph.slotOf(node)
				if (slot !== undefined && graph.orderDependentSlotsOf(slot).length > 0) roots.push(node)
			}
		}
		for (const node of this.dependentClosure.collectOrdering(graph, roots)) {
			if (this.isRunningInRuntime(oldRuntime, node)) oldRunning.add(node)
		}
	}

	private collectPostStartAvailabilityClosure(
		plan: CommitExecutionPlan,
		graph: PluginGraph,
		oldRunning: ReadonlySet<PluginNodeSlot>,
		failed: ReadonlySet<PluginNodeSlot>,
	): Set<PluginNodeSlot> {
		const becameRunning = new Set<PluginNodeSlot>()
		for (const node of plan.toStart) {
			if (!oldRunning.has(node) && !failed.has(node) && this.getRunningRuntimeInstance(node)) {
				becameRunning.add(node)
			}
		}
		const restart = new Set<PluginNodeSlot>()
		for (const node of this.dependentClosure.collectOrdering(graph, becameRunning)) {
			if (becameRunning.has(node) || plan.toStart.has(node)) continue
			if (oldRunning.has(node) && this.getRunningRuntimeInstance(node)) restart.add(node)
		}
		return restart
	}

	private async executePreparedCommit(
		action: PreparedDefinitionBuild,
		meta: RuntimeUpdateCommitMeta,
		onPointOfNoReturn: () => void,
		confirmGraph: () => void,
	): Promise<RuntimeUpdateCommitResult> {
		const oldGraph = this.graph
		const oldRuntime = this.definitions.runtime
		const { delta, graph, runtime } = action
		this._activeGraph = graph
		this._activeRuntime = runtime
		try {
			const plan = this.buildCommitPlan(oldGraph, graph, delta)
			const oldRunning = new Set<PluginNodeSlot>()
			this.expandPreStopAvailabilityClosure(plan, oldGraph, graph, oldRuntime, oldRunning)
			if (isCommitExecutionPlanEmpty(delta, plan)) {
				onPointOfNoReturn()
				confirmGraph()
				this.replacePendingStarts([])
				this.publishCommitSummary(this.graph, {
					runtimeUpdate: createRuntimeUpdateSummary(meta),
					pluginChanges: EMPTY_PLUGIN_COMMIT_CHANGES,
					lifecycleReport: EMPTY_LIFECYCLE_REPORT,
				})
				return createOk({ graph: this.graph, delta: EMPTY_DELTA })
			}

			this.capturePostStartAvailabilityState(plan, graph, oldRuntime, oldRunning)
			const report = createLifecycleReport()
			onPointOfNoReturn()
			await this.applyTeardown(oldGraph, plan.toStopSlots, report)
			// Point of no return: every structural check completed in prepare().
			confirmGraph()
			runtime.deleteMany(collectRuntimeEvictions(plan))
			const failed = await this.startSlotSet(runtime, graph, plan.toStartSlots, report)
			if (failed.size > 0) runtime.deleteMany(failed)

			const postStart = this.collectPostStartAvailabilityClosure(plan, graph, oldRunning, failed)
			if (postStart.size > 0) {
				const slots = new Set<number>()
				for (const node of postStart) {
					const slot = graph.slotOf(node)
					if (slot !== undefined) slots.add(slot)
					plan.toStop.add(node)
					plan.toStart.add(node)
				}
				await this.applyTeardown(graph, slots, report)
				runtime.deleteMany(postStart)
				for (const node of await this.startSlotSet(runtime, graph, slots, report)) failed.add(node)
			}

			const lifecycleReport = finalizeLifecycleReport(report)
			const summary = this.publishCommitSummary(this.graph, {
				runtimeUpdate: createRuntimeUpdateSummary(meta),
				pluginChanges: createPluginCommitChanges(plan, failed),
				lifecycleReport,
			})
			this.observeLateLifecycleIssues(report, summary)
			this.replacePendingStarts(failed)
			return createOk({ graph: this.graph, delta })
		} finally {
			this._activeGraph = undefined
			this._activeRuntime = undefined
		}
	}

	private buildCommitPlan(
		oldGraph: PluginGraph,
		graph: PluginGraph,
		delta: CommitExecutionDelta,
	): CommitExecutionPlan {
		const restartRequested = new Set(this._pendingRestart)
		this._pendingRestart.clear()
		return createCommitExecutionPlan({
			oldGraph,
			graph,
			delta,
			restartRequested,
			pendingStart: this._pendingStart,
			resolveGraphKey: (current, node) => this.resolveGraphKey(current, node),
		})
	}

	private publishCommitSummary(graph: PluginGraph, summary: CommitSummary): CommitSummary {
		const publicSummary: CommitSummary = Object.freeze({
			pluginChanges: summary.pluginChanges,
			runtimeUpdate: summary.runtimeUpdate,
			lifecycleReport: summary.lifecycleReport,
		})
		this._lastCommit = publicSummary
		this.watcherRegistry.publish({ graph, pluginChanges: publicSummary.pluginChanges })
		for (const listener of this.commitListeners) {
			try {
				listener(publicSummary)
			} catch (error) {
				this.ctx.logger.error('Plugin commit listener failed', { error })
			}
		}
		return publicSummary
	}

	private observeLateLifecycleIssues(
		report: MutableLifecycleReport,
		initialSummary: CommitSummary,
	): void {
		let latestSummary = initialSummary
		observeLifecycleReport(report, () => {
			const previous = latestSummary
			const successor: CommitSummary = Object.freeze({
				pluginChanges: previous.pluginChanges,
				runtimeUpdate: previous.runtimeUpdate,
				lifecycleReport: finalizeLifecycleReport(report),
			})
			latestSummary = successor
			if (this._lastCommit === previous) this._lastCommit = successor
			for (const listener of this.commitListeners) {
				try {
					listener(successor)
				} catch (error) {
					this.ctx.logger.error('Plugin commit listener failed', { error })
				}
			}
		})
	}

	private replacePendingStarts(nodes: Iterable<PluginNodeSlot>): void {
		this._pendingStart.clear()
		for (const node of nodes) this._pendingStart.add(node)
	}

	private recoverPendingStarts(): void {
		this._pendingRestart.clear()
		this._pendingStart.clear()
		for (const node of this.graph.keys()) {
			if (isPluginNodeSlot(node) && !this.getRunningRuntimeInstance(node)) {
				this._pendingStart.add(node)
			}
		}
	}

	private label(node: PluginNodeSlot): string {
		return formatPluginNodeReference(this.nodeAddressOf(node))
	}
}

export function createPluginsFailedToStartError(failed: readonly PluginNodeSlot[]): Error {
	return new Error(
		`Some plugins failed to start: ${failed.map((node) => node.definition.exportName).join(', ')}`,
	)
}

export function assertCommitStarted(summary: CommitSummary): void {
	const failed = collectPluginLifecycleNotStarted(summary.lifecycleReport)
	if (failed.length > 0) throw createPluginsFailedToStartError(failed)
}
