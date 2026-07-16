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
import { isProduction } from 'std-env'
import { LoggerService } from '../../logger/LoggerService'
import { EffectsService } from '../../services/effects/EffectsService'
import type { BasePlugin } from '../composition/BasePlugin'
import type { PluginInfo } from '../decorators/decorator/types'
import { getPluginInfo } from '../decorators/PluginDecorator'
// Optional dependency API removed in favor of feature composition (BaseFeature).
import type {
	ForkablePluginConstructor,
	PluginConstructor,
	PluginIdentifier,
	PluginInstance,
} from '../types'
import { computeInitPlan, type InitPlan, startPluginsTopo, stopPluginsTopo } from './commit'
import { forkPlugin, getForkedCtor, listForks } from './fork'
import { runtimePluginKeyOfCtor, type RuntimePluginHandle, type RuntimePluginKey } from './identity'
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
	type PluginReplacement,
} from './plugin-service/CommitPlan'
import {
	assignValidatedConfigBindings,
	hasConfigBindings,
	injectFeatureConfigsFromHostPlugin,
} from './plugin-service/ConfigInjection'
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

type FeatureDeclarationPolicy = 'off' | 'warn' | 'error'

type PluginServiceConfig = {
	pluginCTXIsolate?: AnyServiceClass[]
	startTimeoutMs?: number
	stopTimeoutMs?: number
	startConcurrency?: number
	stopConcurrency?: number
	featureDeclarationPolicy?: FeatureDeclarationPolicy
}

type AnyServiceClass = ServiceClass<new (ctx: PluxelContext, cfg?: unknown) => unknown>
type PluginMutationAction = 'restart' | 'replace'

type RuntimeUpdateCheckpoint = {
	pendingStart: Set<RuntimePluginKey>
	pendingRestart: Set<RuntimePluginKey>
	dependencyOverrides: RuntimeDependencyOverrideSnapshot
}
type RuntimeUpdateCommitResult = Awaited<ReturnType<PluginService['commit']>>

const DEFAULT_START_TIMEOUT_MS = 1_500
const DEFAULT_STOP_TIMEOUT_MS = 3_000
const DEFAULT_START_CONCURRENCY = 8
const DEFAULT_STOP_CONCURRENCY = 1
const FEATURE_DECLARATION_POLICY_KEY = 'pluxel:feature:declarationPolicy'
const DEFAULT_FEATURE_DECLARATION_POLICY_DEV: FeatureDeclarationPolicy = 'warn'
const DEFAULT_FEATURE_DECLARATION_POLICY_PROD: FeatureDeclarationPolicy = 'off'
const STRICT_COMMIT_FEATURE_DECLARATION_POLICY: FeatureDeclarationPolicy = 'error'
const PLUGIN_START_TIMEOUT_METADATA_KEY = 'startTimeoutMs'
const PLUGIN_STOP_TIMEOUT_METADATA_KEY = 'stopTimeoutMs'
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
	private readonly stopTimeoutMs: number
	private readonly startConcurrency: number
	private readonly stopConcurrency: number
	private _lastCommit?: CommitSummary
	/** Active draft graph during commit() before confirm(). */
	private _activeGraph?: PluginGraph
	private _activeRuntime?: PluginRuntime
	/** Plugins that should be (re)started on the next commit. */
	private _pendingStart = new Set<RuntimePluginKey>()
	/** Plugins that should be restarted (re-instantiated) on the next commit. */
	private _pendingRestart = new Set<RuntimePluginKey>()
	private activeRuntimeUpdate?: RuntimeUpdateTransaction<RuntimeUpdateCommitResult>
	private readonly runtimeUpdateCheckpoints = new WeakMap<
		RuntimeUpdateTransaction<RuntimeUpdateCommitResult>,
		RuntimeUpdateCheckpoint
	>()
	private readonly runtimeModules = new RuntimeModuleRegistry()
	private readonly runtimeDependencyOverrides = new RuntimeDependencyOverrides()
	private order = 0
	private readonly featureDeclarationPolicyDefault: FeatureDeclarationPolicy
	private readonly featureDeclarationPolicyExplicit: boolean
	private nextCommitFeatureDeclarationPolicy: FeatureDeclarationPolicy | null = null
	private readonly watcherRegistry: InstanceWatcherRegistry
	private readonly dependentClosure: DependentClosureCollector
	private readonly resolveGraphKeyForCommit = (
		graph: PluginGraph | undefined,
		id: RuntimePluginHandle,
	): RuntimePluginKey | undefined => this.resolveGraphKey(graph, id)
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

	private static readonly FEATURE_DECLARATION_POLICY = Symbol.for(FEATURE_DECLARATION_POLICY_KEY)

	// Internal helpers (single instances; no per‑commit allocations).
	private readonly lifecycleManager: LifecycleManager

	constructor(
		public ctx: PluxelContext,
		config: PluginServiceConfig,
	) {
		this.startTimeoutMs = config?.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS
		this.stopTimeoutMs = config?.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS
		this.startConcurrency = config?.startConcurrency ?? DEFAULT_START_CONCURRENCY
		this.stopConcurrency = config?.stopConcurrency ?? DEFAULT_STOP_CONCURRENCY
		this.featureDeclarationPolicyExplicit =
			config?.featureDeclarationPolicy !== null && config?.featureDeclarationPolicy !== undefined
		this.featureDeclarationPolicyDefault =
			config?.featureDeclarationPolicy ??
			(isProduction
				? DEFAULT_FEATURE_DECLARATION_POLICY_PROD
				: DEFAULT_FEATURE_DECLARATION_POLICY_DEV)

		const isolated = this.resolvePluginIsolatedServices(config)
		this.definitions = new PluginDefinitions(() => this.createPluginContext(isolated), {
			resolveDependencyToken: (token) => this.runtimeModules.resolveDependencyToken(token),
			resolveDependencyTokenOverrides: (pluginId) => this.runtimeDependencyOverrides.get(pluginId),
		})

		this.lifecycleManager = new LifecycleManager(this.ctx, this.startTimeoutMs, this.stopTimeoutMs)
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
		this.applyFeatureDeclarationPolicy(pluginCTX)
		this.pinPluginEffects(pluginCTX)
		return pluginCTX
	}

	private applyFeatureDeclarationPolicy(pluginCTX: PluxelContext): void {
		const override = this.nextCommitFeatureDeclarationPolicy
		if (!this.featureDeclarationPolicyExplicit && (override === null || override === undefined)) {
			return
		}

		const policy = override ?? this.featureDeclarationPolicyDefault
		Object.defineProperty(pluginCTX, PluginService.FEATURE_DECLARATION_POLICY, {
			value: policy,
			writable: false,
			enumerable: false,
			configurable: true,
		})
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
		// Fast path: toolchain injection (configSourcePlugin) produced a configMap/bindings at decoration time.
		const schemaMap = info.configMap ?? undefined
		const bindings = info.configBindingsMap ?? undefined
		if (!schemaMap) return

		const id = info.id

		// Validate + fill defaults before injection (HMR already does this in the loader).
		// Surface any error as a start failure; plugins should not start with invalid config.
		await pluginCtx.configService.ensureValidated(id, schemaMap, { missingObjectDefault: {} })

		// Only inject instance fields when the plugin declared bindings.
		// Some plugins only declare schemas via composed features and don't have any config fields themselves,
		// but still need validation so features can read from the validated snapshot.
		if (hasConfigBindings(bindings)) {
			const record = pluginCtx.configService.getValidatedConfig(id)
			assignValidatedConfigBindings(plugin, bindings, record)
		}

		// Feature instances may be constructed during plugin field initialization (before config injection).
		// After validation + plugin injection, re-run feature config injection so feature fields are updated
		// from the validated snapshot (never from raw).
		try {
			injectFeatureConfigsFromHostPlugin(plugin.features)
		} catch (error) {
			const logger = pluginCtx.logger ?? this.ctx.logger
			logger.error('feature config inject error', { error })
		}
	}

	private resolveGraphKey(
		graph: PluginGraph | undefined,
		id: RuntimePluginHandle,
	): RuntimePluginKey | undefined {
		if (typeof id === 'string') {
			if (!graph || graph.has(id)) return id as RuntimePluginKey
			const resolved = graph.resolve(id)
			return typeof resolved === 'string'
				? (resolved as RuntimePluginKey)
				: (id as RuntimePluginKey)
		}
		try {
			const key = runtimePluginKeyOfCtor(id)
			if (!graph || graph.has(key)) return key
		} catch {
			// Base/abstract tokens may be undecorated; fall back to graph aliases.
		}
		const resolved = graph?.resolve(id)
		if (typeof resolved === 'string') return resolved as RuntimePluginKey
		return undefined
	}

	private resolveRuntimeReadKey(
		graph: PluginGraph | undefined,
		id: PluginIdentifier,
	): RuntimePluginKey | undefined {
		const resolved = this.resolveGraphKey(graph, id)
		if (resolved && graph?.has(resolved)) return resolved
		const owner = this.runtimeModules.resolveDependencyToken(id)
		if (!owner || owner === resolved) return resolved
		return this.resolveGraphKey(graph, owner)
	}

	private activeRuntime(): PluginRuntime {
		return this._activeRuntime ?? this.definitions.runtime
	}

	private currentPlanningGraph(): PluginGraph | undefined {
		if (this._activeGraph) return this._activeGraph
		return this.definitions.hasPendingChanges() ? undefined : this.graph
	}

	private resolvePlanningKey(id: RuntimePluginHandle): RuntimePluginKey | undefined {
		const graph = this.currentPlanningGraph()
		return graph
			? this.resolveGraphKey(graph, id)
			: (this.definitions.resolvePlanningHandle(id) ?? this.resolveGraphKey(undefined, id))
	}

	private resolveRegisteredPlanningKey(
		id: RuntimePluginHandle,
		action: PluginMutationAction,
	): RuntimePluginKey {
		const key = this.tryResolveRegisteredPlanningKey(id)
		if (!key) throw createUnloadedPluginError(action, id)
		return key
	}

	private assertPlanningContains(id: RuntimePluginHandle, action: PluginMutationAction): void {
		if (!this.tryResolveRegisteredPlanningKey(id)) throw createUnloadedPluginError(action, id)
	}

	private tryResolveRegisteredPlanningKey(id: RuntimePluginHandle): RuntimePluginKey | undefined {
		const graph = this.currentPlanningGraph()
		if (!graph) return this.definitions.resolvePlanningHandle(id)
		const key = this.resolveGraphKey(graph, id)
		return key && graph.has(key) ? key : undefined
	}

	private collectPlanningCascadeTargets(
		id: RuntimePluginHandle,
		cascadeDependents = true,
	): Set<RuntimePluginKey> {
		if (!cascadeDependents) {
			const key = this.resolvePlanningKey(id)
			return key ? new Set([key]) : new Set()
		}
		const graph = this.currentPlanningGraph()
		if (graph) {
			const key = this.resolveGraphKey(graph, id)
			if (key) {
				const slot = graph.slotOf(key)
				if (slot !== undefined && graph.dependentSlotsOf(slot).length === 0) {
					return new Set([key])
				}
			}
			return this.dependentClosure.collect(graph, [id])
		}
		return this.definitions.collectPlanningCascadeTargets(id)
	}

	private clearPendingOperations(ids: Iterable<RuntimePluginKey>): void {
		for (const id of ids) {
			this._pendingStart.delete(id)
			this._pendingRestart.delete(id)
		}
	}

	/* ─────────────────────────── State Query ─────────────────────────── */

	isRunning(id: PluginIdentifier): boolean {
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
		plugin: PluginIdentifier | string,
		overrides: RuntimeDependencyOverrideList | undefined,
	): void {
		const pluginId =
			typeof plugin === 'string' ? plugin : getPluginInfo(plugin as PluginConstructor).id
		const { changed, previous } = this.runtimeDependencyOverrides.replace(pluginId, overrides)
		if (!changed) return
		this.recordRuntimeDependencyOverrideSnapshot(pluginId, previous)

		const current = this.resolveRuntimeDependencyOverrideOwner(plugin, pluginId)
		if (!current) return
		const canonical = this.tryResolveRegisteredPlanningKey(current)
		if (!canonical) return
		const provideBase = this.resolveCurrentProvideBase(current, canonical)
		this.definitions.replace(canonical, current, {
			provideBase,
		})
		this._pendingRestart.add(canonical)
	}

	private resolveRuntimeDependencyOverrideOwner(
		plugin: PluginIdentifier | string,
		pluginId: string,
	): PluginConstructor | undefined {
		if (typeof plugin === 'function') return plugin as PluginConstructor

		const runtimeModuleOwner = this.runtimeModules.ctorForName(pluginId)
		if (runtimeModuleOwner) return runtimeModuleOwner

		const graph = this._activeGraph ?? this.graph
		const canonical = this.resolveGraphKey(graph, pluginId)
		const owner = canonical ? graph.declaration(canonical)?.meta?.class : undefined
		return typeof owner === 'function' ? (owner as PluginConstructor) : undefined
	}

	private resolveCurrentProvideBase(
		ctor: PluginConstructor,
		canonical: RuntimePluginKey,
	): boolean | undefined {
		let base: PluginIdentifier | undefined
		try {
			base = getPluginInfo(ctor).base as PluginIdentifier | undefined
		} catch {
			return undefined
		}
		if (!base) return undefined

		const graph = this._activeGraph ?? this.graph
		const declaration = graph.declaration(canonical)
		if (!declaration) return undefined
		return declaration.tokens.includes(base)
	}

	public getRuntimeModuleId(id: PluginIdentifier | string): string | undefined {
		const graph = this._activeGraph ?? this.graph
		const resolved = typeof id === 'string' ? undefined : this.resolveGraphKey(graph, id)
		return this.runtimeModules.getModuleId(id, resolved)
	}

	/**
	 * Resolve a public plugin handle to the committed runtime graph key.
	 *
	 * Constructor handles are compatibility/read-model inputs; they are not stored
	 * as graph tokens unless they are abstract/base aliases.
	 */
	public resolveRuntimeKey(id: PluginIdentifier | string): RuntimePluginKey | undefined {
		const graph = this._activeGraph ?? this.graph
		const key = this.resolveRuntimeReadKey(graph, id as PluginIdentifier)
		return key && graph.has(key) ? key : undefined
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
	): () => void {
		return this.watcherRegistry.watch(this._activeGraph ?? this.graph, id, cb)
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
		return this.getRunningRuntimeInstance(runtimePluginKeyOfCtor(ForkCtor)) as
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
		pluginId: string,
		previous: RuntimeDependencyOverrideList | undefined,
	): void {
		const tx = this.activeRuntimeUpdate
		if (!tx) return
		const checkpoint = this.runtimeUpdateCheckpoints.get(tx)
		if (!checkpoint || checkpoint.dependencyOverrides.has(pluginId)) return
		checkpoint.dependencyOverrides.set(pluginId, previous)
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
	 * not on `effects`.
	 */
	public shutdownSelf(opts?: CascadeOptions) {
		const pluginInfo = (this.ctx as unknown as { pluginInfo?: { class?: unknown } }).pluginInfo
		if (!pluginInfo?.class) {
			throw new Error(SHUTDOWN_OUTSIDE_PLUGIN_CONTEXT_MESSAGE)
		}
		this.unregister(pluginInfo.class as PluginIdentifier, opts)
		return this.commit()
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
			aliases: [canonical],
		})

		// Runtime intent: restart affected plugins so they observe the new provider instance.
		for (const t of targets) this._pendingRestart.add(t)
	}

	/* ─────────────────────────── Commit Internals ─────────────────────────── */

	private enqueueCommit(
		policyOverride: FeatureDeclarationPolicy | null,
		meta: RuntimeUpdateCommitMeta | null = null,
	) {
		const next = this._commitLock
			.then(async () => {
				const prev = this.nextCommitFeatureDeclarationPolicy
				this.nextCommitFeatureDeclarationPolicy = policyOverride
				try {
					return await this.executeCommit(meta)
				} finally {
					this.nextCommitFeatureDeclarationPolicy = prev
				}
			})
			.catch((error) => {
				void this.ctx.logger.with({ error }).error`commit 内部异常`
				return createErr(error)
			})

		this._commitLock = next
		return next
	}

	private async stopPlugin(id: RuntimePluginKey, report: MutableLifecycleReport): Promise<void> {
		// Important: don't call container.get() here; it may instantiate plugins just to stop them.
		// Only stop plugins that were actually constructed (and thus may be running).
		const plugin = this.getRuntimeInstance(id)
		if (!plugin) return
		const snapshot = await this.lifecycleManager.stopLifecycle(id, plugin, {
			timeoutMs: this.resolveStopTimeoutMs(plugin),
		})
		const context = snapshot?.context as { failedStep?: string; err?: unknown } | undefined
		if (context?.failedStep !== 'stop') return
		recordLifecycleIssue(report, {
			plugin: id,
			phase: 'stop',
			kind: PLUGIN_LIFECYCLE_ISSUE_KIND.StopFailed,
			message: context.err ? errorMessage(context.err) : `Plugin ${String(id)} failed to stop`,
			error: context.err ? serializeLifecycleError(context.err) : undefined,
		})
	}

	private resolveStartTimeoutMs(plugin: BasePlugin): number | undefined {
		const info = plugin.ctx.pluginInfo
		return readFinitePositiveMsFromMeta(info.metadata, PLUGIN_START_TIMEOUT_METADATA_KEY)
	}

	private resolveStopTimeoutMs(plugin: BasePlugin): number | undefined {
		const info = plugin.ctx.pluginInfo
		return readFinitePositiveMsFromMeta(info.metadata, PLUGIN_STOP_TIMEOUT_METADATA_KEY)
	}

	private getRuntimeInstance(id: RuntimePluginKey | undefined): BasePlugin | undefined {
		if (!id) return undefined
		return this.activeRuntime().peekByKey(id) as BasePlugin | undefined
	}

	private getRunningRuntimeInstance(id: RuntimePluginKey | undefined): BasePlugin | undefined {
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
			(slot) => graph.dependentSlotsOf(slot),
			toStop,
			async (slot) => {
				const id = graph.keyOf(slot)
				if (id !== undefined) await this.stopPlugin(id as RuntimePluginKey, report)
			},
			{ concurrency: this.stopConcurrency },
		)
	}

	private async instantiateAndStart(
		runtime: PluginRuntime,
		id: RuntimePluginKey,
		report: MutableLifecycleReport,
	): Promise<boolean> {
		const instance = this.resolvePluginInstance(runtime, id, report)
		if (!instance) return false
		if (!(await this.injectPluginConfig(id, instance, report))) return false
		return this.startPluginInstance(runtime, id, instance, report)
	}

	private resolvePluginInstance(
		runtime: PluginRuntime,
		id: RuntimePluginKey,
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
			try {
				this.ctx.emit('resolveError', id, err)
			} catch {
				// ignore: events service may be overridden
			}
			void this.ctx.logger.with({ error: err }).error`解析 ${String(id)} 失败`
			return undefined
		}
	}

	private async injectPluginConfig(
		id: RuntimePluginKey,
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
			try {
				// Treat config injection/validation failures as start errors so callers can observe the root cause.
				this.ctx.emit('startError', pluginCtx, err)
			} catch {
				// ignore: events service may be overridden
			}
			const logger = pluginCtx.logger ?? this.ctx.logger
			void logger.with({ error: err }).error`注入/校验配置到 ${String(id)} 失败`
			await this.disposePluginEffects(pluginCtx)
			return false
		}
	}

	private async startPluginInstance(
		runtime: PluginRuntime,
		id: RuntimePluginKey,
		instance: PluginInstance,
		report: MutableLifecycleReport,
	): Promise<boolean> {
		const pluginCtx = instance.ctx
		try {
			await this.lifecycleManager.startLifecycle(id, instance, this.resolveStartTimeoutMs(instance))
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
			void logger.with({ error }).error`启动 ${String(id)} 失败`
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
				plugin: id as RuntimePluginKey,
				phase: 'dependency',
				kind: PLUGIN_LIFECYCLE_ISSUE_KIND.DependencyBlocked,
				message: `Plugin ${String(id)} could not be scheduled because its dependency graph is cyclic.`,
			})
		}
		return startPluginsTopo(
			plan,
			(slot) => {
				const id = graph.keyOf(slot)
				return id === undefined
					? Promise.resolve(false)
					: this.instantiateAndStart(runtime, id as RuntimePluginKey, report)
			},
			{
				concurrency: this.startConcurrency,
				onDependencyBlocked: (slot, dependency) => {
					const id = graph.keyOf(slot as number)
					const dep = graph.keyOf(dependency as number)
					if (id === undefined || dep === undefined) return
					recordLifecycleIssue(report, {
						plugin: id as RuntimePluginKey,
						phase: 'dependency',
						kind: PLUGIN_LIFECYCLE_ISSUE_KIND.DependencyBlocked,
						blockedBy: dep as RuntimePluginKey,
						message: `Plugin ${String(id)} was not started because dependency ${String(dep)} failed.`,
					})
				},
			},
		)
	}

	/**
	 * 非事务化提交：
	 * - 停机：对 remove/replace 逆拓扑停机
	 * - 启动：对 add/replace 拓扑分批启动；失败只影响其依赖链
	 * - 失败插件从 singletons 中清理（下次 commit 仍会尝试重启）
	 */
	commit() {
		return this.enqueueCommit(null)
	}

	private commitRuntimeUpdate(meta: RuntimeUpdateCommitMeta) {
		return this.enqueueCommit(null, meta)
	}

	/**
	 * Strict commit:
	 * - runs a commit with feature declaration policy set to `error` for this cycle;
	 * - if any plugins failed to start, returns an error result.
	 */
	async commitStrict() {
		const commitResult = await this.enqueueCommit(STRICT_COMMIT_FEATURE_DECLARATION_POLICY)
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
			const oldGraph = this.graph
			const plan = this.buildCommitPlan(oldGraph, graph, {
				added: delta.added as readonly RuntimePluginKey[],
				replaced: delta.replaced as readonly PluginReplacement[],
				removed: delta.removed as readonly RuntimePluginKey[],
			})

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
				remove: [...plan.removed].map(String),
				replace: plan.replaced.map(({ from, to }) => `${String(from)} -> ${String(to)}`),
				add: [...plan.added].map(String),
				restart:
					plan.restartRequested.size > 0 ? [...plan.restartRequested].map(String) : undefined,
			}))
			const lifecycleReport = createLifecycleReport()
			await this.applyTeardown(oldGraph, plan.toStopSlots, lifecycleReport)
			confirm()

			// Ensure fresh instances for restarts/replacements.
			runtime.deleteMany(collectRuntimeEvictions(plan))

			const failed = new Set<RuntimePluginKey>()
			if (plan.toStartSlots.size > 0) {
				const initPlan = computeInitPlan(
					plan.toStartSlots,
					(slot) => graph.depSlotsOf(slot) as readonly number[],
				)
				const failedSlots = await this.startPlugins(runtime, graph, initPlan, lifecycleReport)
				for (const slot of failedSlots) {
					const id = graph.keyOf(slot)
					if (id !== undefined) failed.add(id as RuntimePluginKey)
				}
			}
			// Ensure failed plugins are not observable as "available" for this commit.
			// (They may have been instantiated but not successfully started.)
			if (failed.size > 0) {
				runtime.deleteMany(failed)
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
		this.ctx.internalEvent.runtimeCommitted.emit(summary)
	}

	private replacePendingStarts(ids: Iterable<RuntimePluginKey>): void {
		this._pendingStart.clear()
		for (const id of ids) this._pendingStart.add(id)
	}
}

function isFinitePositiveMs(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function readFinitePositiveMsFromMeta(metadata: unknown, key: string): number | undefined {
	if (!metadata || typeof metadata !== 'object') return undefined
	const value = (metadata as Record<string, unknown>)[key]
	return isFinitePositiveMs(value) ? value : undefined
}

function createUnloadedPluginError(action: PluginMutationAction, id: unknown): Error {
	return new Error(`You can not ${action} an unloaded Plugin: ${String(id)}`)
}
