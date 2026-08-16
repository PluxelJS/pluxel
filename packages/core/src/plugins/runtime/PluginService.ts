// PluginService.ts
// Runtime orchestrator for the plugin system.
//
// Design notes:
// - Non‑transactional commit: container definition switches even if some plugins fail.
// - "Failed" means "not running this cycle", *not* unregistered. As long as a plugin
//   remains registered in the container, future commits may retry it.
// - Performance first: heavy work is split into pure helpers without changing
//   construction/lifecycle hot paths.

import { Injectable, type Context as PluxelContext, type ServiceClass } from '@pluxel/context'
import { createErr, createOk } from 'option-t/plain_result'
import { LoggerService } from '../../logger/LoggerService'
import { EffectsService } from '../../services/effects/EffectsService'
import type { BasePlugin } from '../composition/BasePlugin'
import type { PluginInfo } from '../decorators/decorator/types'
import { getPluginDefinitionFacts, type PluginRef } from './definition'
import type {
	ForkablePluginConstructor,
	PluginConstructor,
	PluginIdentifier,
	PluginInstance,
} from '../types'
import { computeInitPlan, type InitPlan, startPluginsTopo, stopPluginsTopo } from './commit'
import { forkPlugin, getForkedCtor, listForks } from './fork'
import {
	formatPluginNodeAddress,
	isPluginNodeSlot,
	type PluginDefinitionSlot,
	type PluginNodeSlot,
} from './identity'
import { PluginDefinitions, type PluginGraph, type PluginRuntime } from './PluginDefinitions'
import {
	collectRuntimeEvictions,
	createCommitExecutionPlan,
	createPluginCommitChanges,
	createRuntimeUpdateSummary,
	EMPTY_DELTA,
	EMPTY_PLUGIN_COMMIT_CHANGES,
	hasCommitWork,
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
	PLUGIN_LIFECYCLE_ISSUE_KIND,
	recordLifecycleIssue,
	serializeLifecycleError,
	type MutableLifecycleReport,
} from './plugin-service/LifecycleReport'
import {
	RuntimeDependencyOverrides,
	type RuntimeDependencyOverrideList,
	type RuntimeDependencyOverrideSnapshot,
} from './plugin-service/RuntimeDependencyOverrides'
import {
	RuntimeModuleRegistry,
	type RuntimeModuleDeclaration,
	type RuntimeModuleDeclarationItem,
	type RuntimeModuleSnapshot,
} from './plugin-service/RuntimeModuleRegistry'
import {
	createPluginsFailedToStartError,
	PluginRuntimeUpdateTransaction,
	type CascadeOptions,
	type ReplacePluginOptions,
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

/* ─────────────────────────── Types ─────────────────────────── */

type PluginServiceConfig = {
	pluginCTXIsolate?: AnyServiceClass[]
	startTimeoutMs?: number
	drainTimeoutMs?: number
	startConcurrency?: number
	stopConcurrency?: number
}

type AnyServiceClass = ServiceClass<new (ctx: PluxelContext, cfg?: unknown) => unknown>
type PluginMutationAction = 'restart' | 'replace'

type RuntimeUpdateCheckpoint = {
	pendingStart: Set<PluginNodeSlot>
	pendingRestart: Set<PluginNodeSlot>
	dependencyOverrides: RuntimeDependencyOverrideSnapshot
}
type RuntimeUpdateCommitResult = Awaited<ReturnType<PluginService['commit']>>

const DEFAULT_START_TIMEOUT_MS = 1_500
const DEFAULT_DRAIN_TIMEOUT_MS = 3_000
const DEFAULT_START_CONCURRENCY = 8
const DEFAULT_STOP_CONCURRENCY = 1
const INSTANCE_WATCHER_ERROR_MESSAGE = 'instance watcher error'
const RUNTIME_UPDATE_ALREADY_ACTIVE_MESSAGE =
	'Cannot begin runtime update while another runtime update is active'
const RUNTIME_UPDATE_PENDING_DRAFT_MESSAGE =
	'Cannot begin runtime update while registry draft has pending changes'
const SERVICE_VERIFICATION_FAILED_MESSAGE = 'service verification failed'
const SHUTDOWN_OUTSIDE_PLUGIN_CONTEXT_MESSAGE = 'Cannot shutdown: not in a plugin context'

function ensureError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error), { cause: error })
}

/* ─────────────────────────── Module Augmentation ─────────────────────────── */

const serviceName = 'registry' as const
declare module '@pluxel/context' {
	namespace Context {
		interface Config {
			[serviceName]?: PluginServiceConfig
		}
		interface Services {
			[serviceName]: PluginService
		}
	}
	interface Context {
		pluginInfo: PluginInfo
		parent?: Context
		caller?: Context
	}
}

/* ─────────────────────────── Service ─────────────────────────── */

@Injectable({ key: serviceName })
export class PluginService {
	private readonly definitions: PluginDefinitions

	private _commitLock: Promise<unknown> = Promise.resolve()
	private readonly startTimeoutMs: number
	private readonly drainTimeoutMs: number
	private readonly startConcurrency: number
	private readonly stopConcurrency: number
	private _lastCommit?: CommitSummary
	/** Active draft graph during commit() before confirm(). */
	private _activeGraph?: PluginGraph
	private _activeRuntime?: PluginRuntime
	private readonly commitListeners = new Set<(summary: CommitSummary) => void>()
	/** Plugins that should be (re)started on the next commit. */
	private _pendingStart = new Set<PluginNodeSlot>()
	/** Plugins that should be restarted (re-instantiated) on the next commit. */
	private _pendingRestart = new Set<PluginNodeSlot>()
	private activeRuntimeUpdate?: RuntimeUpdateTransaction<RuntimeUpdateCommitResult>
	private readonly runtimeUpdateCheckpoints = new WeakMap<
		RuntimeUpdateTransaction<RuntimeUpdateCommitResult>,
		RuntimeUpdateCheckpoint
	>()
	private readonly runtimeModules: RuntimeModuleRegistry
	private readonly runtimeDependencyOverrides = new RuntimeDependencyOverrides()
	private order = 0
	private readonly watcherRegistry: InstanceWatcherRegistry
	private readonly dependentClosure: DependentClosureCollector
	private readonly resolveGraphKeyForCommit = (
		graph: PluginGraph | undefined,
		id: PluginIdentifier | PluginNodeSlot,
	): PluginNodeSlot | undefined => this.resolveGraphKey(graph, id)
	private readonly runtimeUpdateController: RuntimeUpdateController<RuntimeUpdateCommitResult> = {
		lastCommitSummary: () => this.lastCommit,
		register: (Plugin, opts) => this.register(Plugin, opts),
		unregister: (id, opts) => this.unregister(id, opts),
		replace: (target, next, opts) => this.replace(target, next, opts),
		restart: (id, opts) => this.restart(id, opts),
		commitDraft: (meta) => this.commitRuntimeUpdate(meta),
		completeTransaction: (tx) => this.clearRuntimeUpdateCheckpoint(tx),
		rollbackDraft: (tx) => this.rollbackRuntimeUpdate(tx),
		snapshotRuntimeModule: (moduleId) => this.snapshotRuntimeModule(moduleId),
		restoreRuntimeModule: (moduleId, snapshot) => this.restoreRuntimeModule(moduleId, snapshot),
		upsertRuntimeModule: (module) => this.upsertRuntimeModule(module),
		removeRuntimeModule: (moduleId) => this.removeRuntimeModule(moduleId),
	}

	// Internal helpers (single instances; no per‑commit allocations).
	private readonly lifecycleManager: LifecycleManager

	constructor(
		public ctx: PluxelContext,
		config: PluginServiceConfig = {},
	) {
		this.startTimeoutMs = config?.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS
		this.drainTimeoutMs = config?.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS
		this.startConcurrency = config?.startConcurrency ?? DEFAULT_START_CONCURRENCY
		this.stopConcurrency = config?.stopConcurrency ?? DEFAULT_STOP_CONCURRENCY
		const isolated = this.resolvePluginIsolatedServices(config)
		this.definitions = new PluginDefinitions(() => this.createPluginContext(isolated), {
			resolveDependencyOverrides: (node) => this.runtimeDependencyOverrides.get(node),
		})
		this.runtimeModules = new RuntimeModuleRegistry(this.definitions.slots)

		this.lifecycleManager = new LifecycleManager(
			this.ctx,
			this.definitions.slots,
			this.startTimeoutMs,
			this.drainTimeoutMs,
		)
		this.dependentClosure = new DependentClosureCollector((graph, id) =>
			this.resolveGraphKey(graph, id),
		)
		this.watcherRegistry = new InstanceWatcherRegistry(
			(graph, id) => this.resolveRuntimeReadKey(graph, id),
			(id) => this.getRunningRuntimeInstance(id),
			(error) => {
				this.ctx.logger.error(INSTANCE_WATCHER_ERROR_MESSAGE, { error })
			},
		)
	}

	private resolvePluginIsolatedServices(
		config: PluginServiceConfig | undefined,
	): AnyServiceClass[] {
		const isolated: AnyServiceClass[] = []
		const seen = new Set<AnyServiceClass>()
		for (const svc of config?.pluginCTXIsolate ?? []) {
			const s = svc as unknown as AnyServiceClass
			if (seen.has(s)) continue
			seen.add(s)
			isolated.push(s)
		}
		const effectsSvc = EffectsService as unknown as AnyServiceClass
		if (!seen.has(effectsSvc)) {
			seen.add(effectsSvc)
			isolated.push(effectsSvc)
		}
		const loggerSvc = LoggerService as unknown as AnyServiceClass
		if (!seen.has(loggerSvc)) {
			seen.add(loggerSvc)
			isolated.push(loggerSvc)
		}
		return isolated
	}

	private createPluginContext(isolated: readonly AnyServiceClass[]): PluxelContext {
		const pluginCTX = this.ctx.root.isolate(isolated, { name: `${this.order++}` })
		this.pinPluginEffects(pluginCTX)
		return pluginCTX
	}

	private pinPluginEffects(pluginCTX: PluxelContext): void {
		// Effects are per-plugin by design and used heavily for lifecycle cleanups.
		// Pinning avoids Context service-getter overhead and keeps identity stable.
		try {
			const effects = pluginCTX.effects
			if (effects) {
				Object.defineProperty(pluginCTX, 'effects', {
					value: effects,
					writable: false,
					enumerable: false,
					configurable: true,
				})
			}
		} catch {
			// If effects service was overridden/removed, fall back silently.
		}
	}

	private async injectConfig(plugin: PluginInstance): Promise<void> {
		const pluginCtx = plugin.ctx
		const info: PluginInfo = pluginCtx.pluginInfo
		if (!info.config) return
		const value = await pluginCtx.configService.ensureValidated(info.nodeSlot, info.config.schema, {
			missingObjectDefault: {},
		})
		assignValidatedPluginConfig(plugin, info.config, value)
	}

	private resolveGraphKey(
		graph: PluginGraph | undefined,
		id: PluginIdentifier | PluginNodeSlot,
	): PluginNodeSlot | undefined {
		if (isPluginNodeSlot(id)) return !graph || graph.has(id) ? id : undefined
		const facts = getPluginDefinitionFacts(id)
		const definition = this.definitions.slots.internDefinition(facts.definition)
		if (facts.kind === 'abstract') {
			const resolved = graph?.resolve(definition)
			return isPluginNodeSlot(resolved) ? resolved : undefined
		}
		const node = this.definitions.nodeSlot(id as PluginConstructor)
		return !graph || graph.has(node) ? node : undefined
	}

	private resolveRuntimeReadKey(
		graph: PluginGraph | undefined,
		id: PluginIdentifier | PluginNodeSlot,
	): PluginNodeSlot | undefined {
		return this.resolveGraphKey(graph, id)
	}

	private activeRuntime(): PluginRuntime {
		return this._activeRuntime ?? this.definitions.runtime
	}

	private currentPlanningGraph(): PluginGraph | undefined {
		if (this._activeGraph) return this._activeGraph
		return this.definitions.hasPendingChanges() ? undefined : this.graph
	}

	private resolvePlanningKey(id: PluginIdentifier | PluginNodeSlot): PluginNodeSlot | undefined {
		const graph = this.currentPlanningGraph()
		return graph
			? this.resolveGraphKey(graph, id)
			: (this.definitions.resolvePlanningHandle(id) ?? this.resolveGraphKey(undefined, id))
	}

	private resolveRegisteredPlanningKey(
		id: PluginIdentifier | PluginNodeSlot,
		action: PluginMutationAction,
	): PluginNodeSlot {
		const key = this.tryResolveRegisteredPlanningKey(id)
		if (!key) throw createUnloadedPluginError(action, id)
		return key
	}

	private assertPlanningContains(
		id: PluginIdentifier | PluginNodeSlot,
		action: PluginMutationAction,
	): void {
		if (!this.tryResolveRegisteredPlanningKey(id)) throw createUnloadedPluginError(action, id)
	}

	private tryResolveRegisteredPlanningKey(
		id: PluginIdentifier | PluginNodeSlot,
	): PluginNodeSlot | undefined {
		const graph = this.currentPlanningGraph()
		if (!graph) return this.definitions.resolvePlanningHandle(id)
		const key = this.resolveGraphKey(graph, id)
		return key && graph.has(key) ? key : undefined
	}

	private collectPlanningCascadeTargets(
		id: PluginIdentifier | PluginNodeSlot,
		cascadeDependents = true,
	): Set<PluginNodeSlot> {
		if (!cascadeDependents) {
			const key = this.resolvePlanningKey(id)
			return key ? new Set([key]) : new Set()
		}
		const graph = this.currentPlanningGraph()
		if (graph) {
			const key = this.resolveGraphKey(graph, id)
			if (key) {
				const slot = graph.slotOf(key)
				if (slot !== undefined && graph.orderDependentSlotsOf(slot).length === 0) {
					return new Set([key])
				}
			}
			return this.dependentClosure.collect(graph, [id])
		}
		return this.definitions.collectPlanningCascadeTargets(id)
	}

	private clearPendingOperations(ids: Iterable<PluginNodeSlot>): void {
		for (const id of ids) {
			this._pendingStart.delete(id)
			this._pendingRestart.delete(id)
		}
	}

	/* ─────────────────────────── State Query ─────────────────────────── */

	isRunning(id: PluginIdentifier | PluginNodeSlot): boolean {
		const graph = this._activeGraph ?? this.graph
		const key = this.resolveRuntimeReadKey(graph, id)
		if (!key) return false
		const instance = this.getRuntimeInstance(key)
		return this.lifecycleManager.isRunning(instance)
	}

	/** Whether an identifier is registered in the current draft container. */
	isRegistered(id: PluginIdentifier): boolean {
		return this.definitions.isRegistered(id)
	}

	public get lastCommit(): CommitSummary | undefined {
		return this._lastCommit
	}

	public listRuntimeModuleItems(moduleId: string): readonly RuntimeModuleDeclarationItem[] {
		return this.runtimeModules.listItems(moduleId)
	}

	public replaceRuntimeDependencyOverrides(
		consumer: PluginIdentifier | PluginNodeSlot,
		overrides:
			| readonly (PluginIdentifier | PluginDefinitionSlot | PluginNodeSlot | undefined)[]
			| undefined,
	): void {
		const node = this.resolvePlanningKey(consumer)
		if (!node) throw createUnloadedPluginError('restart', consumer)
		const normalized = overrides?.map((override) => this.normalizeDependencyOverride(override))
		const { changed, previous } = this.runtimeDependencyOverrides.replace(node, normalized)
		if (!changed) return
		this.recordRuntimeDependencyOverrideSnapshot(node, previous)

		const current = this.currentConstructor(node)
		if (!current) return
		this.definitions.replace(node, current, {
			provideBase: this.resolveCurrentProvideBase(current, node),
		})
		for (const target of this.collectPlanningCascadeTargets(node, true)) {
			this._pendingRestart.add(target)
		}
	}

	private currentConstructor(node: PluginNodeSlot): PluginConstructor | undefined {
		const graph = this._activeGraph ?? this.graph
		const owner =
			graph.declaration(node)?.meta?.class ??
			this.definitions.planningDeclaration(node)?.meta?.class
		return typeof owner === 'function' ? (owner as PluginConstructor) : undefined
	}

	private normalizeDependencyOverride(
		override: PluginIdentifier | PluginDefinitionSlot | PluginNodeSlot | undefined,
	): PluginDefinitionSlot | PluginNodeSlot | undefined {
		if (override === undefined) return undefined
		if (isPluginNodeSlot(override)) return override
		if (typeof override === 'object') return override
		const facts = getPluginDefinitionFacts(override)
		return facts.kind === 'abstract'
			? this.definitions.slots.internDefinition(facts.definition)
			: this.definitions.nodeSlot(override as PluginConstructor)
	}

	private resolveCurrentProvideBase(
		ctor: PluginConstructor,
		canonical: PluginNodeSlot,
	): boolean | undefined {
		const provides = getPluginDefinitionFacts(ctor).provides
		if (!provides) return undefined

		const graph = this._activeGraph ?? this.graph
		const declaration =
			graph.declaration(canonical) ?? this.definitions.planningDeclaration(canonical)
		if (!declaration) return undefined
		return declaration.tokens.includes(this.definitions.slots.internDefinition(provides))
	}

	public getRuntimeModuleId(
		id: PluginIdentifier | PluginDefinitionSlot | PluginNodeSlot,
	): string | undefined {
		if (typeof id === 'object') return this.runtimeModules.getModuleId(id)
		return this.runtimeModules.getModuleId(this.definitions.definitionSlot(id))
	}

	/**
	 * Resolve a public plugin handle to the committed runtime graph key.
	 *
	 * Constructor handles are compatibility/read-model inputs; they are not stored
	 * as graph tokens unless they are abstract/base aliases.
	 */
	public resolvePluginNode(id: PluginIdentifier | PluginNodeSlot): PluginNodeSlot | undefined {
		const graph = this._activeGraph ?? this.graph
		const key = isPluginNodeSlot(id) ? id : this.resolveRuntimeReadKey(graph, id)
		return key && graph.has(key) ? key : undefined
	}

	public internNodeAddress(
		address: import('./identity').PluginNodeAddressSnapshot,
	): PluginNodeSlot {
		return this.definitions.slots.internNode(address)
	}

	public internDefinitionAddress(
		address: import('./identity').PluginDefinitionAddressSnapshot,
	): PluginDefinitionSlot {
		return this.definitions.slots.internDefinition(address)
	}

	public definitionAddressOf(
		slot: PluginDefinitionSlot,
	): import('./identity').PluginDefinitionAddressSnapshot {
		return this.definitions.slots.definitionAddress(slot)
	}

	public nodeAddressOf(slot: PluginNodeSlot): import('./identity').PluginNodeAddressSnapshot {
		return this.definitions.slots.nodeAddress(slot)
	}

	public resolvePluginRef<T>(ref: PluginRef<T>, consumer: PluxelContext): T | undefined {
		const definition = this.definitions.slots.internDefinition(ref.definition)
		const graph = this._activeGraph ?? this.graph
		const resolved = graph.resolve(definition)
		if (!isPluginNodeSlot(resolved)) return undefined
		const instance = this.getRunningRuntimeInstance(resolved)
		if (!instance) return undefined
		return this.definitions.callerView(instance, consumer) as T
	}

	/**
	 * Get the current singleton instance for an identifier if it is running.
	 * This does not instantiate or start anything; it only reads the runtime cache + running state.
	 */
	public getInstance<T extends PluginIdentifier>(id: T): InstanceType<T> | undefined {
		const graph = this._activeGraph ?? this.graph
		const key = this.resolveRuntimeReadKey(graph, id)
		if (!key) return undefined
		return this.getRunningRuntimeInstance(key) as InstanceType<T> | undefined
	}

	/**
	 * Watch the runtime instance behind a plugin identifier.
	 *
	 * - The callback is invoked immediately with the current *running* instance (or `undefined`).
	 * - On commits, it is only re-evaluated when the resolved target's availability changes.
	 * - If identifier resolution changes across commits (aliases/replacements), the watcher auto-rebinds.
	 */
	public watchInstance<T extends PluginIdentifier>(
		id: T,
		cb: (instance: InstanceType<T> | undefined) => void,
	): () => void
	public watchInstance(
		id: PluginNodeSlot,
		cb: (instance: BasePlugin | undefined) => void,
	): () => void
	public watchInstance(
		id: PluginIdentifier | PluginNodeSlot,
		cb: (instance: BasePlugin | undefined) => void,
	): () => void {
		const graph = this._activeGraph ?? this.graph
		return isPluginNodeSlot(id)
			? this.watcherRegistry.watch(graph, id, cb)
			: this.watcherRegistry.watch(graph, id, cb)
	}

	/** @internal Subscribe route infrastructure to completed Plugin graph commits. */
	public subscribeCommitted(listener: (summary: CommitSummary) => void): () => void {
		this.commitListeners.add(listener)
		return () => this.commitListeners.delete(listener)
	}

	/** @internal Schedule route-owned work after the currently queued commit settles. */
	public afterCurrentCommit<T>(run: () => T | Promise<T>): Promise<T> {
		return this._commitLock.then(run)
	}

	/* ─────────────────────────── Forks ─────────────────────────── */

	/**
	 * Create (or reuse) a fork ctor for a ForkablePlugin.
	 * This does not register it into the container.
	 */
	public fork<T extends ForkablePluginConstructor>(ctor: T, forkId: string): PluginConstructor {
		return forkPlugin(ctor, forkId)
	}

	/**
	 * Convenience: fork + register into the current draft container.
	 * The fork will be started on the next commit().
	 */
	public registerFork<T extends ForkablePluginConstructor>(
		ctor: T,
		forkId: string,
		opts?: { provideBase?: boolean },
	): PluginConstructor {
		const ForkCtor = forkPlugin(ctor, forkId)
		this.register(ForkCtor, opts)
		return ForkCtor
	}

	/** Get a running fork instance if present; otherwise undefined. */
	public getFork<T extends PluginIdentifier>(ctor: T, forkId: string): InstanceType<T> | undefined {
		const ForkCtor = getForkedCtor(ctor, forkId)
		if (!ForkCtor) return undefined
		return this.getRunningRuntimeInstance(this.definitions.nodeSlot(ForkCtor)) as
			| InstanceType<T>
			| undefined
	}

	/** List all fork ctors created for a given original ctor. */
	public listForks<T extends PluginIdentifier>(ctor: T): PluginConstructor[] {
		return listForks(ctor)
	}

	/* ─────────────────────────── Declaration Layer ─────────────────────────── */

	/** Last committed DI graph. */
	public get graph(): PluginGraph {
		return this.definitions.lastGraph
	}

	/** Roll back draft registrations since last confirmed container. */
	public resetDraft(): void {
		this.definitions.resetDraft()
	}

	/**
	 * Start a bounded runtime declaration update.
	 *
	 * This is intentionally a top-level transaction: PluginDefinitions currently only supports
	 * rollback to the last confirmed graph, so nested updates or updates opened on top of existing
	 * draft mutations would make rollback semantics ambiguous.
	 */
	public beginUpdate(
		options: RuntimeUpdateOptions = {},
	): RuntimeUpdateTransaction<RuntimeUpdateCommitResult> {
		if (this.activeRuntimeUpdate) {
			throw new Error(RUNTIME_UPDATE_ALREADY_ACTIVE_MESSAGE)
		}
		if (this.definitions.hasPendingChanges()) {
			throw new Error(RUNTIME_UPDATE_PENDING_DRAFT_MESSAGE)
		}
		const tx = new PluginRuntimeUpdateTransaction(this.runtimeUpdateController, options)
		this.runtimeUpdateCheckpoints.set(tx, this.createRuntimeUpdateCheckpoint())
		this.activeRuntimeUpdate = tx
		return tx
	}

	private clearRuntimeUpdateCheckpoint(
		tx: RuntimeUpdateTransaction<RuntimeUpdateCommitResult>,
	): void {
		this.runtimeUpdateCheckpoints.delete(tx)
		if (this.activeRuntimeUpdate === tx) this.activeRuntimeUpdate = undefined
	}

	private rollbackRuntimeUpdate(tx: RuntimeUpdateTransaction<RuntimeUpdateCommitResult>): void {
		const checkpoint = this.runtimeUpdateCheckpoints.get(tx)
		this.runtimeUpdateCheckpoints.delete(tx)
		if (this.activeRuntimeUpdate === tx) this.activeRuntimeUpdate = undefined
		this.definitions.resetDraft()
		if (checkpoint) {
			this.restoreRuntimeDependencyOverrides(checkpoint.dependencyOverrides)
			this._pendingStart = new Set(checkpoint.pendingStart)
			this._pendingRestart = new Set(checkpoint.pendingRestart)
		}
	}

	private createRuntimeUpdateCheckpoint(): RuntimeUpdateCheckpoint {
		return {
			pendingStart: new Set(this._pendingStart),
			pendingRestart: new Set(this._pendingRestart),
			dependencyOverrides: new Map(),
		}
	}

	private recordRuntimeDependencyOverrideSnapshot(
		consumer: PluginNodeSlot,
		previous: RuntimeDependencyOverrideList | undefined,
	): void {
		const tx = this.activeRuntimeUpdate
		if (!tx) return
		const checkpoint = this.runtimeUpdateCheckpoints.get(tx)
		if (!checkpoint || checkpoint.dependencyOverrides.has(consumer)) return
		checkpoint.dependencyOverrides.set(consumer, previous)
	}

	private restoreRuntimeDependencyOverrides(snapshots: RuntimeDependencyOverrideSnapshot): void {
		this.runtimeDependencyOverrides.restore(snapshots)
	}

	public upsertRuntimeModule(module: RuntimeModuleDeclaration): void {
		this.runtimeModules.upsert(module)
	}

	public removeRuntimeModule(moduleId: string): void {
		this.runtimeModules.remove(moduleId)
	}

	private snapshotRuntimeModule(moduleId: string): RuntimeModuleSnapshot {
		return this.runtimeModules.snapshot(moduleId)
	}

	private restoreRuntimeModule(moduleId: string, snapshot: RuntimeModuleSnapshot): void {
		this.runtimeModules.restore(moduleId, snapshot)
	}

	/** Register a plugin ctor into the draft container. */
	public register(Plugin: PluginConstructor, opts?: { provideBase?: boolean }): void {
		this.definitions.register(Plugin, opts)
	}

	/**
	 * Unregister a plugin from the declaration layer.
	 * Default behavior cascades to dependents to keep DI verification valid.
	 */
	public unregister(id: PluginIdentifier, opts?: CascadeOptions): void {
		const canonical = this.resolvePlanningKey(id)
		if (!canonical) return
		const targets = this.collectPlanningCascadeTargets(canonical, opts?.cascadeDependents ?? true)
		for (const t of targets) this.definitions.unregister(t)
		this.clearPendingOperations(targets)
		this._pendingStart.delete(canonical)
		this._pendingRestart.delete(canonical)
	}

	/**
	 * Shutdown (unload) the current plugin (and optionally its dependents) from within a plugin context.
	 *
	 * This is an orchestration-layer operation and intentionally lives on PluginService (registry),
	 * not on `effects`. The commit is scheduled and cannot be awaited from the owner call being stopped.
	 */
	public shutdownSelf(opts?: CascadeOptions): void {
		const pluginInfo = (this.ctx as unknown as { pluginInfo?: { class?: unknown } }).pluginInfo
		if (!pluginInfo?.class) {
			throw new Error(SHUTDOWN_OUTSIDE_PLUGIN_CONTEXT_MESSAGE)
		}
		this.unregister(pluginInfo.class as PluginIdentifier, opts)
		// Self-shutdown cannot be awaited from an owner invocation: lifecycle stop must first wait
		// for that invocation lease. Queue the commit and let the current call return.
		void this.commit()
	}

	/**
	 * Restart a registered plugin (and optionally its dependents) on next commit.
	 * This does not change registrations; it only re-instantiates instances.
	 */
	public restart(id: PluginIdentifier, opts?: CascadeOptions): void {
		const canonical = this.resolveRegisteredPlanningKey(id, 'restart')
		const targets = this.collectPlanningCascadeTargets(canonical, opts?.cascadeDependents ?? true)
		for (const key of targets) {
			this.assertPlanningContains(key, 'restart')
			this._pendingRestart.add(key)
		}
	}

	/**
	 * Replace a plugin implementation (HMR) and restart the affected subtree on next commit.
	 */
	public replace(
		target: PluginIdentifier,
		next: PluginConstructor,
		opts?: ReplacePluginOptions,
	): void {
		const canonical = this.resolveRegisteredPlanningKey(target, 'replace')
		const targets = this.collectPlanningCascadeTargets(canonical, opts?.cascadeDependents ?? true)

		this.definitions.replace(canonical, next, {
			provideBase: opts?.provideBase,
		})

		// Runtime intent: restart affected plugins so they observe the new provider instance.
		for (const t of targets) this._pendingRestart.add(t)
	}

	/* ─────────────────────────── Commit Internals ─────────────────────────── */

	private enqueueCommit(meta: RuntimeUpdateCommitMeta | null = null) {
		const next = this._commitLock
			.then(() => this.executeCommit(meta))
			.catch((error) => {
				void this.ctx.logger.with({ error }).error`commit 内部异常`
				return createErr(error)
			})

		this._commitLock = next
		return next
	}

	private async stopPlugin(id: PluginNodeSlot, report: MutableLifecycleReport): Promise<void> {
		// Important: don't call container.get() here; it may instantiate plugins just to stop them.
		// Only stop plugins that were actually constructed (and thus may be running).
		const plugin = this.getRuntimeInstance(id)
		if (!plugin) return
		const snapshot = await this.lifecycleManager.stopLifecycle(id, plugin)
		const context = snapshot?.context as { failedStep?: string; err?: unknown } | undefined
		if (context?.failedStep !== 'drain') return
		recordLifecycleIssue(report, {
			plugin: id,
			phase: 'drain',
			kind: PLUGIN_LIFECYCLE_ISSUE_KIND.DrainFailed,
			message: context.err ? errorMessage(context.err) : `Plugin ${this.label(id)} failed to drain`,
			error: context.err ? serializeLifecycleError(context.err) : undefined,
		})
	}

	private resolveStartTimeoutMs(plugin: BasePlugin): number | undefined {
		return plugin.ctx.pluginInfo.startTimeoutMs
	}

	private getRuntimeInstance(id: PluginNodeSlot | undefined): BasePlugin | undefined {
		if (!id) return undefined
		return this.activeRuntime().peekByKey(id) as BasePlugin | undefined
	}

	private getRunningRuntimeInstance(id: PluginNodeSlot | undefined): BasePlugin | undefined {
		const instance = this.getRuntimeInstance(id)
		return instance && this.lifecycleManager.isRunning(instance) ? instance : undefined
	}

	private async applyTeardown(
		graph: PluginGraph | undefined,
		toStop: Set<number>,
		report: MutableLifecycleReport,
	): Promise<void> {
		if (!graph || toStop.size === 0) return
		// Default concurrency is 1 (sequential) to preserve legacy stop behavior.
		await stopPluginsTopo(
			(slot) => graph.orderDependentSlotsOf(slot),
			toStop,
			async (slot) => {
				const id = graph.keyOf(slot)
				if (isPluginNodeSlot(id)) await this.stopPlugin(id, report)
			},
			{ concurrency: this.stopConcurrency },
		)
	}

	private async instantiateAndStart(
		runtime: PluginRuntime,
		id: PluginNodeSlot,
		report: MutableLifecycleReport,
	): Promise<boolean> {
		const instance = this.resolvePluginInstance(runtime, id, report)
		if (!instance) return false
		if (!(await this.injectPluginConfig(id, instance, report))) return false
		return this.startPluginInstance(runtime, id, instance, report)
	}

	private resolvePluginInstance(
		runtime: PluginRuntime,
		id: PluginNodeSlot,
		report: MutableLifecycleReport,
	): PluginInstance | undefined {
		try {
			return runtime.ensureByKey(id) as PluginInstance
		} catch (error) {
			const err = ensureError(error)
			recordLifecycleIssue(report, {
				plugin: id,
				phase: 'resolve',
				kind: PLUGIN_LIFECYCLE_ISSUE_KIND.ResolveFailed,
				message: err.message,
				error: serializeLifecycleError(err),
			})
			void this.ctx.logger.with({ error: err }).error`解析 ${this.label(id)} 失败`
			return undefined
		}
	}

	private async injectPluginConfig(
		id: PluginNodeSlot,
		instance: PluginInstance,
		report: MutableLifecycleReport,
	): Promise<boolean> {
		const pluginCtx = instance.ctx

		// Core responsibility: inject declared config fields before plugin init().
		// Doing it directly avoids an extra event hop on every plugin start.
		try {
			await this.injectConfig(instance)
			return true
		} catch (error) {
			const err = ensureError(error)
			recordLifecycleIssue(report, {
				plugin: id,
				phase: 'config',
				kind: PLUGIN_LIFECYCLE_ISSUE_KIND.ConfigFailed,
				message: err.message,
				error: serializeLifecycleError(err),
			})
			const logger = pluginCtx.logger ?? this.ctx.logger
			void logger.with({ error: err }).error`注入/校验配置到 ${this.label(id)} 失败`
			await this.disposePluginEffects(pluginCtx)
			return false
		}
	}

	private async startPluginInstance(
		runtime: PluginRuntime,
		id: PluginNodeSlot,
		instance: PluginInstance,
		report: MutableLifecycleReport,
	): Promise<boolean> {
		const pluginCtx = instance.ctx
		try {
			await this.lifecycleManager.startLifecycle(
				id,
				instance,
				this.resolveStartTimeoutMs(instance),
				(error, phase) => {
					recordLifecycleIssue(report, {
						plugin: id,
						phase,
						kind:
							phase === 'drain'
								? PLUGIN_LIFECYCLE_ISSUE_KIND.DrainFailed
								: PLUGIN_LIFECYCLE_ISSUE_KIND.StartFailed,
						message: errorMessage(error),
						error: serializeLifecycleError(error),
					})
				},
			)
			return true
		} catch (error) {
			recordLifecycleIssue(report, {
				plugin: id,
				phase: 'start',
				kind: PLUGIN_LIFECYCLE_ISSUE_KIND.StartFailed,
				message: errorMessage(error),
				error: serializeLifecycleError(error),
			})
			const logger = pluginCtx.logger ?? this.ctx.logger
			void logger.with({ error }).error`启动 ${this.label(id)} 失败`
			await this.disposePluginEffects(pluginCtx)
			runtime.delete(id)
			return false
		}
	}

	private async disposePluginEffects(pluginCtx: PluxelContext): Promise<void> {
		try {
			await pluginCtx.effects.dispose()
		} catch {
			/* ignored */
		}
	}

	private startPlugins(
		runtime: PluginRuntime,
		graph: PluginGraph,
		plan: InitPlan<number>,
		report: MutableLifecycleReport,
	): Promise<Set<number>> {
		for (const slot of plan.leftovers) {
			const id = graph.keyOf(slot)
			if (id === undefined) continue
			recordLifecycleIssue(report, {
				plugin: id as PluginNodeSlot,
				phase: 'dependency',
				kind: PLUGIN_LIFECYCLE_ISSUE_KIND.DependencyBlocked,
				message: `Plugin ${this.label(id as PluginNodeSlot)} could not be scheduled because its dependency graph is cyclic.`,
			})
		}
		return startPluginsTopo(
			plan,
			(slot) => {
				const id = graph.keyOf(slot)
				return id === undefined
					? Promise.resolve(false)
					: this.instantiateAndStart(runtime, id as PluginNodeSlot, report)
			},
			{
				concurrency: this.startConcurrency,
				blocks: (slot, dependency) =>
					graph.depSlotsOf(slot as number).includes(dependency as number),
				onDependencyBlocked: (slot, dependency) => {
					const id = graph.keyOf(slot as number)
					const dep = graph.keyOf(dependency as number)
					if (id === undefined || dep === undefined) return
					recordLifecycleIssue(report, {
						plugin: id as PluginNodeSlot,
						phase: 'dependency',
						kind: PLUGIN_LIFECYCLE_ISSUE_KIND.DependencyBlocked,
						blockedBy: dep as PluginNodeSlot,
						message: `Plugin ${this.label(id as PluginNodeSlot)} was not started because dependency ${this.label(dep as PluginNodeSlot)} failed.`,
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
		const initPlan = computeInitPlan(
			slots,
			(slot) => graph.orderDepSlotsOf(slot) as readonly number[],
		)
		const failedSlots = await this.startPlugins(runtime, graph, initPlan, report)
		for (const slot of failedSlots) {
			const id = graph.keyOf(slot)
			if (isPluginNodeSlot(id)) failed.add(id)
		}
		return failed
	}

	private collectRunningNodes(graph: PluginGraph, runtime: PluginRuntime): Set<PluginNodeSlot> {
		const running = new Set<PluginNodeSlot>()
		for (const key of graph.keys()) {
			if (!isPluginNodeSlot(key)) continue
			const instance = runtime.peekByKey<BasePlugin>(key)
			if (this.lifecycleManager.isRunning(instance)) running.add(key)
		}
		return running
	}

	/**
	 * Any running generation that will stop must first stop its required/optional dependent
	 * closure. This covers running -> absent and running generation A -> B before the provider
	 * is drained. Absent roots deliberately do not disturb their consumers here.
	 */
	private expandPreStopAvailabilityClosure(
		plan: CommitExecutionPlan,
		oldGraph: PluginGraph,
		graph: PluginGraph,
		oldRunning: ReadonlySet<PluginNodeSlot>,
	): void {
		const runningRoots = [...plan.toStop].filter((node) => oldRunning.has(node))
		if (runningRoots.length === 0) return
		const closure = this.dependentClosure.collectOrdering(oldGraph, runningRoots)
		for (const node of closure) {
			if (!oldRunning.has(node)) continue
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

	/**
	 * Providers that were absent before this commit are attempted without stopping consumers.
	 * Only a successful absent -> running transition restarts the already-running ordering
	 * closure. This is the second phase that keeps absent -> absent retries side-effect free.
	 */
	private collectPostStartAvailabilityClosure(
		plan: CommitExecutionPlan,
		graph: PluginGraph,
		oldRunning: ReadonlySet<PluginNodeSlot>,
		failed: ReadonlySet<PluginNodeSlot>,
	): Set<PluginNodeSlot> {
		const becameRunning = new Set<PluginNodeSlot>()
		for (const node of plan.toStart) {
			if (oldRunning.has(node) || failed.has(node)) continue
			if (this.getRunningRuntimeInstance(node)) becameRunning.add(node)
		}
		if (becameRunning.size === 0) return new Set()

		const closure = this.dependentClosure.collectOrdering(graph, becameRunning)
		const restart = new Set<PluginNodeSlot>()
		for (const node of closure) {
			if (becameRunning.has(node) || plan.toStart.has(node)) continue
			if (!oldRunning.has(node) || !this.getRunningRuntimeInstance(node)) continue
			restart.add(node)
		}
		return restart
	}

	/**
	 * 非事务化提交：
	 * - 停机：对 remove/replace 逆拓扑停机
	 * - 启动：对 add/replace 拓扑分批启动；失败只影响其依赖链
	 * - 失败插件从 singletons 中清理（下次 commit 仍会尝试重启）
	 */
	commit() {
		return this.enqueueCommit()
	}

	private commitRuntimeUpdate(meta: RuntimeUpdateCommitMeta) {
		return this.enqueueCommit(meta)
	}

	/**
	 * Strict commit:
	 * - if any plugins failed to start, returns an error result.
	 */
	async commitStrict() {
		const commitResult = await this.enqueueCommit()
		if (!commitResult.ok) return commitResult
		const summary = this._lastCommit
		const failed = collectPluginLifecycleNotStarted(summary?.lifecycleReport)
		if (failed.length > 0) {
			return createErr(createPluginsFailedToStartError(failed))
		}
		return commitResult
	}

	private async executeCommit(meta: RuntimeUpdateCommitMeta | null = null) {
		const runtimeUpdate = createRuntimeUpdateSummary(meta)
		if (
			!hasCommitWork(
				this.definitions.hasPendingChanges(),
				this._pendingStart.size,
				this._pendingRestart.size,
			)
		) {
			const graph = this.graph
			this.publishCommitSummary({
				graph,
				runtimeUpdate,
				pluginChanges: EMPTY_PLUGIN_COMMIT_CHANGES,
				lifecycleReport: EMPTY_LIFECYCLE_REPORT,
			})
			return createOk({ graph, delta: EMPTY_DELTA })
		}

		const oldGraph = this.graph
		const oldRuntime = this.definitions.runtime
		const oldRunning = this.collectRunningNodes(oldGraph, oldRuntime)
		const action = this.definitions.build()
		if (!action.ok) {
			action.err.reset()
			void this.ctx.logger.with({ error: action.err.err, detail: String(action.err.err) })
				.error`插件在依赖项解析时失败`
			return createErr(new Error(SERVICE_VERIFICATION_FAILED_MESSAGE, { cause: action.err.err }))
		}

		const { delta, graph, runtime, confirm } = action.val
		this._activeGraph = graph
		this._activeRuntime = runtime
		try {
			const plan = this.buildCommitPlan(oldGraph, graph, delta)
			this.expandPreStopAvailabilityClosure(plan, oldGraph, graph, oldRunning)

			// No-op commit: still report state (after applying pending restarts/retries).
			if (isCommitExecutionPlanEmpty(delta, plan)) {
				confirm()
				this.replacePendingStarts([])
				this.publishCommitSummary({
					graph: this.graph,
					runtimeUpdate,
					pluginChanges: EMPTY_PLUGIN_COMMIT_CHANGES,
					lifecycleReport: EMPTY_LIFECYCLE_REPORT,
				})
				return createOk({ graph: this.graph, delta })
			}

			this.ctx.logger.info('插件变更', () => ({
				remove: [...plan.removed].map((node) => this.label(node)),
				replace: plan.replaced.map(({ from, to }) => `${this.label(from)} -> ${this.label(to)}`),
				add: [...plan.added].map((node) => this.label(node)),
				restart:
					plan.restartRequested.size > 0
						? [...plan.restartRequested].map((node) => this.label(node))
						: undefined,
			}))
			const lifecycleReport = createLifecycleReport()
			await this.applyTeardown(oldGraph, plan.toStopSlots, lifecycleReport)
			confirm()

			// Ensure fresh instances for restarts/replacements.
			runtime.deleteMany(collectRuntimeEvictions(plan))

			const failed = await this.startSlotSet(runtime, graph, plan.toStartSlots, lifecycleReport)
			// Ensure failed plugins are not observable as "available" for this commit.
			// (They may have been instantiated but not successfully started.)
			if (failed.size > 0) {
				runtime.deleteMany(failed)
			}

			const postStartRestart = this.collectPostStartAvailabilityClosure(
				plan,
				graph,
				oldRunning,
				failed,
			)
			if (postStartRestart.size > 0) {
				const postStopSlots = new Set<number>()
				const postStartSlots = new Set<number>()
				for (const node of postStartRestart) {
					const slot = graph.slotOf(node)
					if (slot === undefined) continue
					plan.toStop.add(node)
					plan.toStart.add(node)
					plan.toStopSlots.add(slot)
					plan.toStartSlots.add(slot)
					postStopSlots.add(slot)
					postStartSlots.add(slot)
				}
				await this.applyTeardown(graph, postStopSlots, lifecycleReport)
				runtime.deleteMany(postStartRestart)
				const postFailed = await this.startSlotSet(runtime, graph, postStartSlots, lifecycleReport)
				for (const node of postFailed) failed.add(node)
				if (postFailed.size > 0) runtime.deleteMany(postFailed)
			}

			const lifecycleReportResult = finalizeLifecycleReport(lifecycleReport)
			this.publishCommitSummary({
				graph: this.graph,
				runtimeUpdate,
				pluginChanges: createPluginCommitChanges(plan, failed),
				lifecycleReport: lifecycleReportResult,
			})

			// update pending retry set
			this.replacePendingStarts(failed)

			if (!lifecycleReportResult.ok) {
				this.ctx.logger.warn('插件生命周期报告包含错误', { lifecycleReport: lifecycleReportResult })
			}

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
		// Restart requests are author intent; normalize them against both the previous and next graph.
		const restartRequested = new Set(this._pendingRestart)
		this._pendingRestart.clear()
		return createCommitExecutionPlan({
			oldGraph,
			graph,
			delta,
			restartRequested,
			pendingStart: this._pendingStart,
			resolveGraphKey: this.resolveGraphKeyForCommit,
		})
	}

	private publishCommitSummary(summary: CommitSummary): void {
		this._lastCommit = summary
		this.watcherRegistry.publish(summary)
		for (const listener of this.commitListeners) {
			try {
				listener(summary)
			} catch (error) {
				this.ctx.logger.error('Plugin commit listener failed', { error })
			}
		}
	}

	private replacePendingStarts(ids: Iterable<PluginNodeSlot>): void {
		this._pendingStart.clear()
		for (const id of ids) this._pendingStart.add(id)
	}

	private label(node: PluginNodeSlot): string {
		return formatPluginNodeAddress(this.definitions.slots.nodeAddress(node))
	}
}

function createUnloadedPluginError(action: PluginMutationAction, id: unknown): Error {
	return new Error(`You can not ${action} an unloaded Plugin: ${String(id)}`)
}
