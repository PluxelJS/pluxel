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
import { isProduction } from '../../env'
import { EffectsService } from '../../services/effects/EffectsService'
import type { BasePlugin } from '../composition/BasePlugin'
import type { PluginInfo } from '../decorators/decorator/types'
// Optional dependency API removed in favor of feature composition (BaseFeature).
import type {
	ForkablePluginConstructor,
	PluginConstructor,
	PluginIdentifier,
	PluginInstance,
} from '../types'
import {
	computeInitPlan,
	type InitPlan,
	type PluginStartStrategy,
	startPluginsWithStrategy,
	stopPluginsTopo,
} from './commit'
import { forkPlugin, getForkedCtor, listForks } from './fork'
import { LifecycleManager } from './LifecycleManager'
import { PluginDefinitions, type PluginGraph, type PluginRuntime } from './PluginDefinitions'

/* ─────────────────────────── Types ─────────────────────────── */

type PluginServiceConfig = {
	pluginCTXIsolate?: AnyServiceClass[]
	startTimeoutMs?: number
	stopTimeoutMs?: number
	startStrategy?: PluginStartStrategy
	startConcurrency?: number
	stopConcurrency?: number
	featureDeclarationPolicy?: 'off' | 'warn' | 'error'
}

type AnyServiceClass = ServiceClass<new (ctx: PluxelContext, cfg?: unknown) => unknown>
type CascadeOptions = { cascadeDependents?: boolean }
type ReplacePluginOptions = CascadeOptions & { provideBase?: boolean }
type PluginReplacement = { from: PluginIdentifier; to: PluginIdentifier }
type CommitExecutionPlan = {
	added: Set<PluginIdentifier>
	replaced: PluginReplacement[]
	removed: Set<PluginIdentifier>
	restartRequested: Set<PluginIdentifier>
	toStop: Set<PluginIdentifier>
	toStart: Set<PluginIdentifier>
	toStopSlots: Set<number>
	toStartSlots: Set<number>
}

export interface CommitSummary {
	graph: PluginGraph
	added: PluginIdentifier[]
	replaced: PluginReplacement[]
	removed: PluginIdentifier[]
	failed: PluginIdentifier[]
	/**
	 * Plugins whose runtime availability may have changed in this commit.
	 *
	 * This includes anything that was stopped or (re)started (adds, replaces, restarts, retries).
	 * Useful for efficient optional-dependency watchers (e.g. FeatureHost.dep).
	 */
	touched: PluginIdentifier[]
}

type InstanceWatcher = {
	token: PluginIdentifier
	resolved: PluginIdentifier
	lastRaw: BasePlugin | undefined
	lastNotifiedSeq: number
	cb: (instance: BasePlugin | undefined) => void
}

type DependentScratch = {
	marks: Uint8Array
	slots: number[]
	stack: number[]
}

class DependentClosureCollector {
	private scratch: DependentScratch = {
		marks: new Uint8Array(0),
		slots: [],
		stack: [],
	}

	public constructor(
		private readonly resolveGraphKey: (
			graph: PluginGraph | undefined,
			id: PluginIdentifier,
		) => PluginIdentifier,
	) {}

	public collect(
		graph: PluginGraph | undefined,
		roots: Iterable<PluginIdentifier>,
	): Set<PluginIdentifier> {
		if (!graph) return new Set(roots)

		if (this.scratch.marks.length < graph.slotCount()) {
			this.scratch = {
				marks: new Uint8Array(graph.slotCount()),
				slots: [],
				stack: [],
			}
		}

		const { marks, slots, stack } = this.scratch
		slots.length = 0
		stack.length = 0
		const affected = new Set<PluginIdentifier>()
		for (const root of roots) {
			const canonical = this.resolveGraphKey(graph, root)
			const slot = graph.slotOf(canonical)
			if (slot === undefined) {
				affected.add(canonical)
				continue
			}
			if (marks[slot] === 1) continue
			marks[slot] = 1
			slots.push(slot)
			stack.push(slot)
		}

		while (stack.length > 0) {
			const current = stack.pop()!
			const currentKey = graph.keyOf(current)
			if (currentKey !== undefined) affected.add(currentKey as PluginIdentifier)
			const dependents = graph.dependentSlotsOf(current)
			for (let i = 0; i < dependents.length; i++) {
				const dep = dependents[i]!
				if (!Number.isInteger(dep) || dep < 0 || dep >= marks.length) continue
				if (marks[dep] === 1) continue
				marks[dep] = 1
				slots.push(dep)
				stack.push(dep)
			}
		}

		for (let i = 0; i < slots.length; i++) marks[slots[i]!] = 0
		slots.length = 0
		stack.length = 0
		return affected
	}
}

class InstanceWatcherRegistry {
	private readonly byResolved = new Map<PluginIdentifier, Set<InstanceWatcher>>()
	private commitSeq = 0

	public constructor(
		private readonly resolveGraphKey: (
			graph: PluginGraph | undefined,
			id: PluginIdentifier,
		) => PluginIdentifier,
		private readonly getRunningRuntimeInstance: (id: PluginIdentifier) => BasePlugin | undefined,
		private readonly logError: (error: unknown) => void,
	) {}

	public watch<T extends PluginIdentifier>(
		graph: PluginGraph | undefined,
		id: T,
		cb: (instance: InstanceType<T> | undefined) => void,
	): () => void {
		const resolved = this.resolveGraphKey(graph, id)
		const entry: InstanceWatcher = {
			token: id,
			resolved,
			lastRaw: this.getRunningRuntimeInstance(resolved),
			lastNotifiedSeq: this.commitSeq,
			cb: cb as unknown as (instance: BasePlugin | undefined) => void,
		}
		this.add(entry)

		try {
			entry.cb(entry.lastRaw as BasePlugin | undefined)
		} catch (error) {
			this.logError(error)
		}

		let active = true
		return () => {
			if (!active) return
			active = false
			this.remove(entry)
		}
	}

	public publish(summary: CommitSummary): void {
		if (this.byResolved.size === 0) return
		const touched = summary.touched
		if (touched.length === 0) return
		const seq = ++this.commitSeq
		const touchedSet = new Set(touched)

		for (let i = 0; i < touched.length; i++) {
			const set = this.byResolved.get(touched[i]!)
			if (!set || set.size === 0) continue
			this.flush(set, summary, seq)
		}

		const retargeted: InstanceWatcher[] = []
		for (const [resolved, set] of this.byResolved) {
			if (touchedSet.has(resolved)) continue
			for (const entry of set) {
				const nextResolved = (summary.graph.resolve(entry.token) ?? entry.token) as PluginIdentifier
				if (nextResolved !== entry.resolved) retargeted.push(entry)
			}
		}
		for (let i = 0; i < retargeted.length; i++) this.notify(retargeted[i]!, summary, seq)
	}

	private flush(set: Set<InstanceWatcher>, summary: CommitSummary, seq: number): void {
		for (const entry of set) this.notify(entry, summary, seq)
	}

	private notify(entry: InstanceWatcher, summary: CommitSummary, seq: number): void {
		if (entry.lastNotifiedSeq === seq) return
		entry.lastNotifiedSeq = seq

		const nextResolved = (summary.graph.resolve(entry.token) ?? entry.token) as PluginIdentifier
		if (nextResolved !== entry.resolved) {
			this.remove(entry)
			entry.resolved = nextResolved
			this.add(entry)
		}

		const raw = this.getRunningRuntimeInstance(entry.resolved)
		if (raw === entry.lastRaw) return
		entry.lastRaw = raw
		try {
			entry.cb(raw)
		} catch (error) {
			this.logError(error)
		}
	}

	private add(entry: InstanceWatcher): void {
		let set = this.byResolved.get(entry.resolved)
		if (!set) {
			set = new Set()
			this.byResolved.set(entry.resolved, set)
		}
		set.add(entry)
	}

	private remove(entry: InstanceWatcher): void {
		const set = this.byResolved.get(entry.resolved)
		set?.delete(entry)
		if (set && set.size === 0) this.byResolved.delete(entry.resolved)
	}
}

/* ─────────────────────────── Module Augmentation ─────────────────────────── */

const serviceName = 'registry' as const
declare module '@pluxel/context' {
	// oxlint-disable-next-line eslint/no-unused-vars -- declaration merging target namespace
	namespace Context {
		// oxlint-disable-next-line eslint/no-unused-vars -- declaration merging target interface
		interface Config {
			[serviceName]?: PluginServiceConfig
		}
	}
	export interface Context {
		pluginInfo: PluginInfo
		parent?: Context
		caller?: Context
	}
	export namespace Context {
		// oxlint-disable-next-line eslint/no-unused-vars -- declaration merging target interface
		interface Services {
			[serviceName]: PluginService
		}
	}
}

/* ─────────────────────────── Service ─────────────────────────── */

@Injectable({ key: serviceName })
export class PluginService {
	private readonly definitions: PluginDefinitions

	private _commitLock: Promise<unknown> = Promise.resolve()
	private readonly startTimeoutMs: number
	private readonly stopTimeoutMs: number
	private readonly startStrategy: PluginStartStrategy
	private readonly startConcurrency: number
	private readonly stopConcurrency: number
	private _lastCommit?: CommitSummary
	/** Active draft graph during commit() before confirm(). */
	private _activeGraph?: PluginGraph
	private _activeRuntime?: PluginRuntime
	/** Plugins that should be (re)started on the next commit. */
	private _pendingStart = new Set<PluginIdentifier>()
	/** Plugins that should be restarted (re-instantiated) on the next commit. */
	private _pendingRestart = new Set<PluginIdentifier>()
	private order = 0
	private readonly featureDeclarationPolicyDefault: 'off' | 'warn' | 'error'
	private readonly featureDeclarationPolicyExplicit: boolean
	private nextCommitFeatureDeclarationPolicy: 'off' | 'warn' | 'error' | null = null
	private readonly watcherRegistry: InstanceWatcherRegistry
	private readonly dependentClosure: DependentClosureCollector

	private static readonly FEATURE_DECLARATION_POLICY = Symbol.for(
		'pluxel:feature:declarationPolicy',
	)

	// Internal helpers (single instances; no per‑commit allocations).
	private readonly lifecycle: LifecycleManager

	constructor(
		public ctx: PluxelContext,
		config: PluginServiceConfig,
	) {
		this.startTimeoutMs = config?.startTimeoutMs ?? 1_500
		this.stopTimeoutMs = config?.stopTimeoutMs ?? 3_000
		this.startStrategy = config?.startStrategy ?? 'ready-queue'
		this.startConcurrency = config?.startConcurrency ?? 8
		this.stopConcurrency = config?.stopConcurrency ?? 1
		this.featureDeclarationPolicyExplicit =
			config?.featureDeclarationPolicy !== null && config?.featureDeclarationPolicy !== undefined
		this.featureDeclarationPolicyDefault =
			config?.featureDeclarationPolicy ?? (isProduction ? 'off' : 'warn')

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
		this.definitions = new PluginDefinitions(() => {
			const pluginCTX = this.ctx.root.isolate(isolated, { name: `${this.order++}` })
			const override = this.nextCommitFeatureDeclarationPolicy
			if (this.featureDeclarationPolicyExplicit || (override !== null && override !== undefined)) {
				const policy = override ?? this.featureDeclarationPolicyDefault
				Object.defineProperty(pluginCTX, PluginService.FEATURE_DECLARATION_POLICY, {
					value: policy,
					writable: false,
					enumerable: false,
					configurable: true,
				})
			}

			// Effects are per‑plugin by design and used heavily for lifecycle cleanups.
			// Pin the instance to:
			// 1) avoid Context service‑getter overhead on hot paths;
			// 2) keep identity stable for this plugin context.
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

			return pluginCTX
		})

		this.lifecycle = new LifecycleManager(this.ctx, this.startTimeoutMs, this.stopTimeoutMs)
		this.dependentClosure = new DependentClosureCollector((graph, id) =>
			this.resolveGraphKey(graph, id),
		)
		this.watcherRegistry = new InstanceWatcherRegistry(
			(graph, id) => this.resolveGraphKey(graph, id),
			(id) => this.getRunningRuntimeInstance(id),
			(error) => {
				this.ctx.logger.error('instance watcher error', { error })
			},
		)
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
		if (bindings && Object.keys(bindings).length > 0) {
			const record = pluginCtx.configService.getValidatedConfig(id)
			const pluginObj = plugin as unknown as Record<string, unknown>
			const recordObj = record as unknown as Record<string, unknown>

			for (const field of Object.keys(bindings)) {
				const keys = bindings[field] ?? []
				if (!Array.isArray(keys) || keys.length === 0) {
					pluginObj[field] = Object.create(null)
					continue
				}
				if (keys.length === 1) {
					pluginObj[field] = recordObj[keys[0] as string]
					continue
				}
				const view: Record<string, unknown> = Object.create(null)
				for (let i = 0; i < keys.length; i++) {
					const k = keys[i] as string
					view[k] = recordObj[k]
				}
				pluginObj[field] = view
			}
		}

		// Feature instances may be constructed during plugin field initialization (before config injection).
		// After validation + plugin injection, re-run feature config injection so feature fields are updated
		// from the validated snapshot (never from raw).
		try {
			const host = plugin.features as unknown as { __injectConfigsFromHostPlugin?: () => void }
			host.__injectConfigsFromHostPlugin?.()
		} catch (error) {
			const logger = pluginCtx.logger ?? this.ctx.logger
			logger.error('feature config inject error', { error })
		}
	}

	private resolveGraphKey(graph: PluginGraph | undefined, id: PluginIdentifier): PluginIdentifier {
		if (!graph) return id
		return (graph.resolve(id) ?? id) as PluginIdentifier
	}

	private activeRuntime(): PluginRuntime {
		return this._activeRuntime ?? this.definitions.runtime
	}

	private hasDraftStructuralChanges(): boolean {
		return this._activeGraph !== undefined || this.definitions.hasPendingChanges()
	}

	private resolvePlanningKey(id: PluginIdentifier): PluginIdentifier {
		if (!this.hasDraftStructuralChanges()) return this.resolveGraphKey(this.graph, id)
		return this._activeGraph
			? this.resolveGraphKey(this._activeGraph, id)
			: this.definitions.resolvePlanning(id)
	}

	private planningContains(id: PluginIdentifier): boolean {
		if (!this.hasDraftStructuralChanges()) {
			const graph = this.graph
			return graph.has(id) || graph.resolve(id) !== undefined
		}
		if (this._activeGraph) return this._activeGraph.has(id) || this._activeGraph.resolve(id) !== undefined
		const resolved = this.definitions.resolvePlanning(id)
		return resolved !== id || this.definitions.isRegistered(id)
	}

	private collectPlanningCascadeTargets(
		id: PluginIdentifier,
		cascadeDependents = true,
	): Set<PluginIdentifier> {
		if (!cascadeDependents) return new Set([id])
		if (!this.hasDraftStructuralChanges()) return this.dependentClosure.collect(this.graph, [id])
		if (this._activeGraph) return this.dependentClosure.collect(this._activeGraph, [id])
		return this.definitions.collectPlanningCascadeTargets(id)
	}

	private clearPendingOperations(ids: Iterable<PluginIdentifier>): void {
		for (const id of ids) {
			this._pendingStart.delete(id)
			this._pendingRestart.delete(id)
		}
	}

	private collectRuntimeEvictions(plan: CommitExecutionPlan): Set<PluginIdentifier> {
		const evict = new Set<PluginIdentifier>(plan.toStop)
		for (let i = 0; i < plan.replaced.length; i++) {
			evict.add(plan.replaced[i]!.from)
		}
		for (const id of plan.toStart) {
			if (!plan.toStop.has(id)) evict.add(id)
		}
		return evict
	}

	/* ─────────────────────────── State Query ─────────────────────────── */

	isRunning(id: PluginIdentifier): boolean {
		const graph = this._activeGraph ?? this.graph
		const key = this.resolveGraphKey(graph, id)
		const instance = this.getRuntimeInstance(key)
		return this.lifecycle.isRunning(instance)
	}

	/** Whether an identifier is registered in the current draft container. */
	isRegistered(id: PluginIdentifier): boolean {
		return this.definitions.isRegistered(id)
	}

	public get lastCommit(): CommitSummary | undefined {
		return this._lastCommit
	}

	/**
	 * Get the current singleton instance for an identifier if it is running.
	 * This does not instantiate or start anything; it only reads the runtime cache + running state.
	 */
	public getInstance<T extends PluginIdentifier>(id: T): InstanceType<T> | undefined {
		const graph = this._activeGraph ?? this.graph
		const key = this.resolveGraphKey(graph, id)
		return this.getRunningRuntimeInstance(key) as InstanceType<T> | undefined
	}

	/**
	 * Watch the runtime instance behind a plugin identifier.
	 *
	 * - The callback is invoked immediately with the current *running* instance (or `undefined`).
	 * - On commits, it is only re-evaluated when the *resolved* target is touched (start/stop/restart/replace).
	 * - If identifier resolution changes across commits (aliases/replacements), the watcher auto-rebinds.
	 */
	public watchInstance<T extends PluginIdentifier>(
		id: T,
		cb: (instance: InstanceType<T> | undefined) => void,
	): () => void {
		return this.watcherRegistry.watch(this._activeGraph ?? this.graph, id, cb)
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
		return this.getRunningRuntimeInstance(ForkCtor) as InstanceType<T> | undefined
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
			throw new Error('Cannot shutdown: not in a plugin context')
		}
		this.unregister(pluginInfo.class as PluginIdentifier, opts)
		return this.commit()
	}

	/**
	 * Restart a registered plugin (and optionally its dependents) on next commit.
	 * This does not change registrations; it only re-instantiates instances.
	 */
	public restart(id: PluginIdentifier, opts?: CascadeOptions): void {
		if (!this.planningContains(id)) {
			throw new Error(`You can not restart an unloaded Plugin: ${String(id)}`)
		}
		const canonical = this.resolvePlanningKey(id)
		const targets = this.collectPlanningCascadeTargets(canonical, opts?.cascadeDependents ?? true)
		for (const t of targets) {
			const key = this.resolvePlanningKey(t)
			if (!this.planningContains(key)) {
				throw new Error(`You can not restart an unloaded Plugin: ${String(t)}`)
			}
			this._pendingRestart.add(key)
		}
	}

	/**
	 * Replace a plugin implementation (HMR) while keeping old tokens resolvable via alias.
	 * Also schedules a restart for the affected subtree on next commit.
	 */
	public replace(
		target: PluginIdentifier,
		next: PluginConstructor,
		opts?: ReplacePluginOptions,
	): void {
		const canonical = this.resolvePlanningKey(target)
		const targets = this.collectPlanningCascadeTargets(canonical, opts?.cascadeDependents ?? true)

		this.definitions.replace(canonical, next, {
			provideBase: opts?.provideBase,
			aliases: [target, canonical],
		})

		// Runtime intent: restart affected plugins so they observe the new provider instance.
		for (const t of targets) this._pendingRestart.add(t)
	}

	/* ─────────────────────────── Commit Internals ─────────────────────────── */

	private enqueueCommit(policyOverride: 'off' | 'warn' | 'error' | null) {
		const next = this._commitLock
			.then(async () => {
				const prev = this.nextCommitFeatureDeclarationPolicy
				this.nextCommitFeatureDeclarationPolicy = policyOverride
				try {
					return await this.executeCommit()
				} finally {
					this.nextCommitFeatureDeclarationPolicy = prev
				}
			})
			.catch((error) => {
				this.ctx.logger.with({ error }).error`commit 内部异常`
				return createErr(error)
			})

		this._commitLock = next
		return next
	}

	private async stopPlugin(id: PluginIdentifier): Promise<void> {
		// Important: don't call container.get() here; it may instantiate plugins just to stop them.
		// Only stop plugins that were actually constructed (and thus may be running).
		const plugin = this.getRuntimeInstance(id)
		if (!plugin) return
		await this.lifecycle.stopLifecycle(id, plugin, { timeoutMs: this.resolveStopTimeoutMs(plugin) })
	}

	private resolveStartTimeoutMs(plugin: BasePlugin): number | undefined {
		const info = plugin.ctx.pluginInfo
		return readFinitePositiveMsFromMeta(info.metadata, 'startTimeoutMs')
	}

	private resolveStopTimeoutMs(plugin: BasePlugin): number | undefined {
		const info = plugin.ctx.pluginInfo
		return readFinitePositiveMsFromMeta(info.metadata, 'stopTimeoutMs')
	}

	private getRuntimeInstance(id: PluginIdentifier): BasePlugin | undefined {
		return this.activeRuntime().peekByKey(id) as BasePlugin | undefined
	}

	private getRunningRuntimeInstance(id: PluginIdentifier): BasePlugin | undefined {
		const instance = this.getRuntimeInstance(id)
		return instance && this.lifecycle.isRunning(instance) ? instance : undefined
	}

	private async applyTeardown(graph: PluginGraph | undefined, toStop: Set<number>): Promise<void> {
		if (!graph || toStop.size === 0) return
		// Default concurrency is 1 (sequential) to preserve legacy stop behavior.
		await stopPluginsTopo(
			(slot) => graph.dependentSlotsOf(slot),
			toStop,
			async (slot) => {
				const id = graph.keyOf(slot)
				if (id !== undefined) await this.stopPlugin(id as PluginIdentifier)
			},
			{ concurrency: this.stopConcurrency },
		)
	}

	private async instantiateAndStart(
		runtime: PluginRuntime,
		id: PluginIdentifier,
	): Promise<boolean> {
		let instance: PluginInstance
		try {
			instance = runtime.ensureByKey(id) as PluginInstance
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error), { cause: error })
			try {
				this.ctx.emit('resolveError', id, err)
			} catch {
				// ignore: events service may be overridden
			}
			this.ctx.logger.with({ error: err }).error`解析 ${String(id)} 失败`
			return false
		}
		const pluginCtx = instance.ctx

		// Core responsibility: inject declared config fields before plugin init().
		// Doing it directly avoids an extra event hop on every plugin start.
		try {
			await this.injectConfig(instance)
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error), { cause: error })
			try {
				// Treat config injection/validation failures as start errors so callers can observe the root cause.
				this.ctx.emit('startError', pluginCtx, err)
			} catch {
				// ignore: events service may be overridden
			}
			const logger = pluginCtx.logger ?? this.ctx.logger
			logger.with({ error: err }).error`注入/校验配置到 ${String(id)} 失败`
			try {
				await pluginCtx.effects.dispose()
			} catch {
				/* ignored */
			}
			return false
		}

		try {
			await this.lifecycle.startLifecycle(id, instance, this.resolveStartTimeoutMs(instance))
			return true
		} catch (error) {
			const logger = pluginCtx.logger ?? this.ctx.logger
			logger.with({ error }).error`启动 ${String(id)} 失败`
			try {
				await pluginCtx.effects.dispose()
			} catch {
				/* ignored */
			}
			runtime.delete(id)
			return false
		}
	}

	private startPlugins(
		runtime: PluginRuntime,
		graph: PluginGraph,
		plan: InitPlan<number>,
	): Promise<Set<number>> {
		return startPluginsWithStrategy(
			plan,
			(slot) => {
				const id = graph.keyOf(slot)
				return id === undefined
					? Promise.resolve(false)
					: this.instantiateAndStart(runtime, id as PluginIdentifier)
			},
			{ strategy: this.startStrategy, concurrency: this.startConcurrency },
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

	/**
	 * Strict commit:
	 * - runs a commit with feature declaration policy set to `error` for this cycle;
	 * - if any plugins failed to start, returns an error result.
	 */
	async commitStrict() {
		const res = await this.enqueueCommit('error')
		if (!res.ok) return res
		const summary = this._lastCommit
		if (summary?.failed.length) {
			return createErr(
				new Error(`Some plugins failed to start: ${summary.failed.map(String).join(', ')}`),
			)
		}
		return res
	}

	private async executeCommit() {
		const action = this.definitions.build()
		if (!action.ok) {
			action.err.reset()
			this.ctx.logger.with({ error: action.err.err, detail: String(action.err.err) })
				.error`插件在依赖项解析时失败`
			return createErr(new Error('service verification failed', { cause: action.err.err }))
		}

		const { delta, graph, runtime, confirm } = action.val
		this._activeGraph = graph
		this._activeRuntime = runtime
		try {
			const oldGraph = this.graph
			const plan = this.buildCommitPlan(oldGraph, graph, {
				added: delta.added as readonly PluginIdentifier[],
				replaced: delta.replaced as readonly PluginReplacement[],
				removed: delta.removed as readonly PluginIdentifier[],
			})

			// No-op commit: still report state (after applying pending restarts/retries).
			if (
				delta.added.length === 0 &&
				delta.removed.length === 0 &&
				delta.replaced.length === 0 &&
				plan.toStopSlots.size === 0 &&
				plan.toStartSlots.size === 0
			) {
				confirm()
				this.publishCommitSummary({
					graph: this.graph,
					added: [],
					replaced: [],
					removed: [],
					failed: [],
					touched: [],
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
			await this.applyTeardown(oldGraph, plan.toStopSlots)
			confirm()

			// Ensure fresh instances for restarts/replacements.
			runtime.deleteMany(this.collectRuntimeEvictions(plan))

			let failed = new Set<PluginIdentifier>()
			if (plan.toStartSlots.size > 0) {
				const initPlan = computeInitPlan(
					plan.toStartSlots,
					(slot) => graph.depSlotsOf(slot) as readonly number[],
				)
				const failedSlots = await this.startPlugins(runtime, graph, initPlan)
				for (const slot of failedSlots) {
					const id = graph.keyOf(slot)
					if (id !== undefined) failed.add(id as PluginIdentifier)
				}
			}

			// Ensure failed plugins are not observable as "available" for this commit.
			// (They may have been instantiated but not successfully started.)
			if (failed.size > 0) {
				runtime.deleteMany(failed)
			}

			this.publishCommitSummary({
				graph: this.graph,
				added: [...plan.added],
				replaced: [...plan.replaced],
				removed: [...plan.removed],
				failed: [...failed],
				touched: [...new Set<PluginIdentifier>([...plan.toStop, ...plan.toStart])],
			})

			// update pending retry set
			this.replacePendingStarts(failed)

			if (failed.size > 0) {
				this.ctx.logger.warn('以下插件启动失败', { failed: [...failed].map(String) })
				this.ctx.emit('commitFailed', failed)
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
		delta: {
			added: readonly PluginIdentifier[]
			replaced: readonly PluginReplacement[]
			removed: readonly PluginIdentifier[]
		},
	): CommitExecutionPlan {
		const added = new Set(delta.added)
		const replaced = [...delta.replaced]
		const removed = new Set(delta.removed)

		// Restart requests are author intent; normalize them against both the previous and next graph.
		const restartRequested = new Set(this._pendingRestart)
		this._pendingRestart.clear()

		const toStop = new Set<PluginIdentifier>(removed)
		const toStart = new Set<PluginIdentifier>()

		for (let i = 0; i < replaced.length; i++) {
			const { from, to } = replaced[i]!
			toStop.add(from)
			if (graph.has(to)) toStart.add(to)
		}
		for (const id of added) {
			if (graph.has(id)) toStart.add(id)
		}
		for (const id of restartRequested) {
			const stopKey = this.resolveGraphKey(oldGraph, id)
			if (oldGraph.has(stopKey)) toStop.add(stopKey)
			const startKey = this.resolveGraphKey(graph, id)
			if (graph.has(startKey)) toStart.add(startKey)
		}

		// Retry previously failed plugins opportunistically on any later commit.
		for (const id of this._pendingStart) {
			if (toStop.has(id)) continue
			const key = this.resolveGraphKey(graph, id)
			if (graph.has(key)) toStart.add(key)
		}

		return {
			added,
			replaced,
			removed,
			restartRequested,
			toStop,
			toStart,
			toStopSlots: this.collectExistingSlots(oldGraph, toStop),
			toStartSlots: this.collectExistingSlots(graph, toStart),
		}
	}

	private collectExistingSlots(
		graph: PluginGraph,
		ids: Iterable<PluginIdentifier>,
	): Set<number> {
		const slots = new Set<number>()
		for (const id of ids) {
			const slot = graph.slotOf(id)
			if (slot !== undefined) slots.add(slot)
		}
		return slots
	}

	private publishCommitSummary(summary: CommitSummary): void {
		this._lastCommit = summary
		this.watcherRegistry.publish(summary)
		this.ctx.emit('afterCommit', summary)
	}

	private replacePendingStarts(ids: Iterable<PluginIdentifier>): void {
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
