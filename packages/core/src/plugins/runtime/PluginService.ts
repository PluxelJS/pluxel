// PluginService.ts
// Runtime orchestrator for the plugin system.
//
// Design notes:
// - Non‑transactional commit: container definition switches even if some plugins fail.
// - "Failed" means "not running this cycle", *not* unregistered. As long as a plugin
//   remains registered in the container, future commits may retry it.
// - Performance first: heavy work is split into pure helpers without changing
//   construction/lifecycle hot paths.

import type { Context, ServiceClass } from '@pluxel/context'
import { Injectable } from '@pluxel/context'
import { createErr, createOk } from 'option-t/plain_result'
import type { ServiceMap } from '../../container'
import { LeanMapTracker } from '../../container/LeanMapTracker'
import { isProduction } from '../../env'
import { EffectsService } from '../../services/effects/EffectsService'
import type { BasePlugin } from '../composition/BasePlugin'
import type { PluginInfo } from '../decorators/PluginDecorator'
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
	partitionChanges,
	startPluginsWithStrategy,
	stopPluginsTopo,
} from './commit'
import { forkPlugin, getForkedCtor, listForks } from './fork'
import { LifecycleManager } from './LifecycleManager'
import { PluginDefinitions, type PluginDiContainer } from './PluginDefinitions'

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

type AnyServiceClass = ServiceClass<new (ctx: Context, cfg?: unknown) => unknown>

export interface CommitSummary {
	container: PluginDiContainer
	added: PluginIdentifier[]
	replaced: PluginIdentifier[]
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

/* ─────────────────────────── Module Augmentation ─────────────────────────── */

const serviceName = 'registry' as const
declare module '@pluxel/context' {
	namespace Context {
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
		interface Services {
			[serviceName]: PluginService
		}
	}
}

/* ─────────────────────────── Service ─────────────────────────── */

@Injectable({ key: serviceName })
export class PluginService {
	private readonly definitions: PluginDefinitions
	private readonly builderSingletons = new LeanMapTracker<PluginIdentifier, PluginInstance>()
	/**
	 * Runtime instances that were detached from the DI builder cache by draft mutations
	 * (e.g. `unregister()` / `replace()`), but are still running until the next commit.
	 *
	 * This exists because `diod`'s builder currently deletes builder-singletons on
	 * unregister, which would otherwise make teardown impossible before commit.
	 */
	private readonly detachedSingletons = new Map<PluginIdentifier, PluginInstance>()

	private _commitLock: Promise<unknown> = Promise.resolve()
	private readonly startTimeoutMs: number
	private readonly stopTimeoutMs: number
	private readonly startStrategy: PluginStartStrategy
	private readonly startConcurrency: number
	private readonly stopConcurrency: number
	private _lastCommit?: CommitSummary
	/** Active draft container during commit() before confirm(). */
	private _activeContainer?: PluginDiContainer
	/** Plugins that should be (re)started on the next commit. */
	private _pendingStart = new Set<PluginIdentifier>()
	/** Plugins that should be restarted (re-instantiated) on the next commit. */
	private _pendingRestart = new Set<PluginIdentifier>()
	private order = 0
	private readonly featureDeclarationPolicyDefault: 'off' | 'warn' | 'error'
	private readonly featureDeclarationPolicyExplicit: boolean
	private nextCommitFeatureDeclarationPolicy: 'off' | 'warn' | 'error' | null = null
	private readonly instanceWatchersByResolved = new Map<PluginIdentifier, Set<InstanceWatcher>>()
	private commitSeq = 0

	private static readonly FEATURE_DECLARATION_POLICY = Symbol.for(
		'pluxel:feature:declarationPolicy',
	)

	// Internal helpers (single instances; no per‑commit allocations).
	private readonly lifecycle: LifecycleManager

	constructor(
		public ctx: Context,
		config: PluginServiceConfig,
	) {
		this.startTimeoutMs = config?.startTimeoutMs ?? 1_500
		this.stopTimeoutMs = config?.stopTimeoutMs ?? 3_000
		this.startStrategy = config?.startStrategy ?? 'ready-queue'
		this.startConcurrency = config?.startConcurrency ?? 8
		this.stopConcurrency = config?.stopConcurrency ?? 1
		this.featureDeclarationPolicyExplicit = config?.featureDeclarationPolicy != null
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
			if (this.featureDeclarationPolicyExplicit || override != null) {
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
		}, this.builderSingletons)

		this.lifecycle = new LifecycleManager(this.ctx, this.startTimeoutMs, this.stopTimeoutMs)
	}

	private async injectConfig(plugin: PluginInstance): Promise<void> {
		const pluginCtx = plugin.ctx
		const info: PluginInfo = pluginCtx.pluginInfo
		const schemaMap = info.configMap ?? undefined
		if (!schemaMap) return

		const id = info.id

		// Validate + fill defaults before injection (HMR already does this in the loader).
		// Surface any error as a start failure; plugins should not start with invalid config.
		await pluginCtx.configService.ensureValidated(id, schemaMap, { missingObjectDefault: {} })

		const record = pluginCtx.configService.getValidatedConfig(id)
		const pluginObj = plugin as unknown as Record<string, unknown>
		const recordObj = record as unknown as Record<string, unknown>

		for (const key in schemaMap) {
			if (!Object.hasOwn(schemaMap, key)) continue
			// Feature configs are merged into the host plugin schema as namespaced keys (e.g. "cache.config").
			// They belong to the host plugin *config panel*, but should not be injected onto the plugin instance.
			if (key.includes('.')) continue
			pluginObj[key] = recordObj[key]
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

	private resolveIdentifier(
		container: PluginDiContainer | undefined,
		id: PluginIdentifier,
	): PluginIdentifier {
		const resolver = (container as unknown as { resolveIdentifier?: unknown })?.resolveIdentifier
		if (typeof resolver !== 'function') return id
		// Important: preserve `this` binding for container methods.
		const out = (resolver as (this: PluginDiContainer, x: unknown) => unknown).call(container, id)
		return (out ?? id) as PluginIdentifier
	}

	private services(container: PluginDiContainer): ServiceMap<BasePlugin> {
		return container.services as unknown as ServiceMap<BasePlugin>
	}

	/* ─────────────────────────── State Query ─────────────────────────── */

	isRunning(id: PluginIdentifier): boolean {
		const container = this._activeContainer ?? this.container
		const key = this.resolveIdentifier(container, id)
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
		const container = this._activeContainer ?? this.container
		const key = this.resolveIdentifier(container, id)
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
		const container = this._activeContainer ?? this.container
		const resolved = this.resolveIdentifier(container, id)
		const entry: InstanceWatcher = {
			token: id,
			resolved,
			lastRaw: this.getRunningRuntimeInstance(resolved),
			lastNotifiedSeq: this.commitSeq,
			cb: cb as unknown as (instance: BasePlugin | undefined) => void,
		}

		let set = this.instanceWatchersByResolved.get(resolved)
		if (!set) {
			set = new Set()
			this.instanceWatchersByResolved.set(resolved, set)
		}
		set.add(entry)

		// Immediate notification.
		try {
			entry.cb(entry.lastRaw as BasePlugin | undefined)
		} catch (error) {
			this.ctx.logger.error('instance watcher error', { error })
		}

		let active = true
		return () => {
			if (!active) return
			active = false
			const cur = this.instanceWatchersByResolved.get(entry.resolved)
			cur?.delete(entry)
			if (cur && cur.size === 0) this.instanceWatchersByResolved.delete(entry.resolved)
		}
	}

	private notifyInstanceWatchers(summary: CommitSummary, seq: number): void {
		if (this.instanceWatchersByResolved.size === 0) return
		const touched = summary.touched
		if (!touched.length) return

		const resolver = (summary.container as unknown as { resolveIdentifier?: unknown })
			.resolveIdentifier
		const resolveIdentifier =
			typeof resolver === 'function'
				? (resolver as (this: PluginDiContainer, id: unknown) => unknown)
				: undefined

		for (let i = 0; i < touched.length; i++) {
			const touchedKey = touched[i]!
			const set = this.instanceWatchersByResolved.get(touchedKey)
			if (!set || set.size === 0) continue

			// Iterate the Set directly to avoid per-commit allocations.
			// Mutations are expected (callbacks may add/remove watchers); we allow them.
			for (const entry of set) {
				// If a callback registers watchers during the current notification cycle,
				// watchInstance() invokes them immediately. Don't notify them again here.
				if (entry.lastNotifiedSeq === seq) continue
				entry.lastNotifiedSeq = seq

				const nextResolved = resolveIdentifier
					? (resolveIdentifier.call(summary.container, entry.token) ?? entry.token)
					: entry.token

				if (nextResolved !== entry.resolved) {
					const prevSet = this.instanceWatchersByResolved.get(entry.resolved)
					prevSet?.delete(entry)
					if (prevSet && prevSet.size === 0) this.instanceWatchersByResolved.delete(entry.resolved)

					entry.resolved = nextResolved as PluginIdentifier
					let nextSet = this.instanceWatchersByResolved.get(entry.resolved)
					if (!nextSet) {
						nextSet = new Set()
						this.instanceWatchersByResolved.set(entry.resolved, nextSet)
					}
					nextSet.add(entry)
				}

				const raw = this.getRunningRuntimeInstance(entry.resolved)
				if (raw === entry.lastRaw) continue
				entry.lastRaw = raw
				try {
					entry.cb(raw)
				} catch (error) {
					this.ctx.logger.error('instance watcher error', { error })
				}
			}
		}
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

	/** Last committed DI container (may be undefined before the first successful commit). */
	public get container(): PluginDiContainer | undefined {
		return this.definitions.lastContainer
	}

	/** Roll back draft registrations since last confirmed container. */
	public resetDraft(): void {
		this.definitions.resetDraft()
		this.pruneDetachedSingletons()
	}

	/** Register a plugin ctor into the draft container. */
	public register(Plugin: PluginConstructor, opts?: { provideBase?: boolean }): void {
		this.definitions.register(Plugin, opts)
	}

	private collectDependents(
		container: PluginDiContainer | undefined,
		roots: Iterable<PluginIdentifier>,
	): Set<PluginIdentifier> {
		if (!container) return new Set(roots)
		const resolve = (id: PluginIdentifier) => this.resolveIdentifier(container, id)
		const dependents = container.dependents as unknown as ReadonlyMap<
			PluginIdentifier,
			Set<PluginIdentifier>
		>

		const affected = new Set<PluginIdentifier>()
		const stack: PluginIdentifier[] = []
		for (const r of roots) stack.push(resolve(r))

		while (stack.length) {
			const current = stack.pop()!
			if (affected.has(current)) continue
			affected.add(current)
			const children = dependents.get(current)
			if (!children) continue
			for (const dep of children) stack.push(resolve(dep))
		}
		return affected
	}

	/**
	 * Unregister a plugin from the declaration layer.
	 * Default behavior cascades to dependents to keep DI verification valid.
	 */
	public unregister(id: PluginIdentifier, opts?: { cascadeDependents?: boolean }): void {
		const cascade = opts?.cascadeDependents ?? true
		const container = this.container
		const targets = cascade ? this.collectDependents(container, [id]) : new Set([id])
		for (const t of targets) this.stashRuntimeInstance(t)
		for (const t of targets) this.definitions.unregister(t)
		for (const t of targets) {
			this._pendingStart.delete(t)
			this._pendingRestart.delete(t)
		}
	}

	/**
	 * Shutdown (unload) the current plugin (and optionally its dependents) from within a plugin context.
	 *
	 * This is an orchestration-layer operation and intentionally lives on PluginService (registry),
	 * not on `effects`.
	 */
	public shutdownSelf(opts?: { cascadeDependents?: boolean }) {
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
	public restart(id: PluginIdentifier, opts?: { cascadeDependents?: boolean }): void {
		const cascade = opts?.cascadeDependents ?? true
		const container = this.container
		const targets = cascade ? this.collectDependents(container, [id]) : new Set([id])
		for (const t of targets) {
			if (container) {
				const services = this.services(container)
				const key = this.resolveIdentifier(container, t)
				if (!services.has(key)) {
					throw new Error(`You can not restart an unloaded Plugin: ${String(t)}`)
				}
			} else {
				throw new Error(`You can not restart an unloaded Plugin: ${String(t)}`)
			}
			this._pendingRestart.add(t)
		}
	}

	/**
	 * Replace a plugin implementation (HMR) while keeping old tokens resolvable via alias.
	 * Also schedules a restart for the affected subtree on next commit.
	 */
	public replace(
		target: PluginIdentifier,
		next: PluginConstructor,
		opts?: { cascadeDependents?: boolean; provideBase?: boolean },
	): void {
		const container = this.container
		const canonical = this.resolveIdentifier(container, target)
		const targets =
			(opts?.cascadeDependents ?? true)
				? this.collectDependents(container, [canonical])
				: new Set([canonical])

		// Update declaration layer: unregister old provider and register new one with aliases.
		this.stashRuntimeInstance(canonical)
		this.definitions.unregister(canonical)
		this.definitions.register(next, {
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

	private pruneDetachedSingletons(): void {
		// Detached instances are only needed when the DI builder cache no longer holds them.
		// Prune entries that became reachable again via builderSingletons (e.g. undo/resetDraft).
		if (this.detachedSingletons.size === 0) return
		for (const id of this.detachedSingletons.keys()) {
			if (this.builderSingletons.has(id)) this.detachedSingletons.delete(id)
		}
	}

	private getRuntimeInstance(id: PluginIdentifier): BasePlugin | undefined {
		return (
			(this.builderSingletons.get(id) as BasePlugin | undefined) ??
			(this.detachedSingletons.get(id) as BasePlugin | undefined)
		)
	}

	private getRunningRuntimeInstance(id: PluginIdentifier): BasePlugin | undefined {
		const instance = this.getRuntimeInstance(id)
		return instance && this.lifecycle.isRunning(instance) ? instance : undefined
	}

	private stashRuntimeInstance(id: PluginIdentifier): void {
		const container = this._activeContainer ?? this.container
		const key = this.resolveIdentifier(container, id)
		const instance = this.builderSingletons.get(key)
		if (instance) this.detachedSingletons.set(key, instance)
	}

	private async applyTeardown(
		container: PluginDiContainer | undefined,
		toStop: Set<PluginIdentifier>,
	): Promise<void> {
		if (!container || toStop.size === 0) return
		// Default concurrency is 1 (sequential) to preserve legacy stop behavior.
		await stopPluginsTopo(
			container.dependents as unknown as ReadonlyMap<PluginIdentifier, Set<PluginIdentifier>>,
			toStop,
			(id) => this.stopPlugin(id),
			{ concurrency: this.stopConcurrency },
		)
	}

	private async instantiateAndStart(
		container: PluginDiContainer,
		id: PluginIdentifier,
		failed: Set<PluginIdentifier>,
	): Promise<void> {
		const resolution = container.getResult(id)
		if (resolution.err) {
			const err =
				resolution.err instanceof Error
					? resolution.err
					: new Error(String(resolution.err), { cause: resolution.err })
			try {
				this.ctx.emit('resolveError', id, err)
			} catch {
				// ignore: events service may be overridden
			}
			failed.add(id)
			this.ctx.logger.with({ error: err }).error`解析 ${String(id)} 失败`
			return
		}

		const instance: PluginInstance = resolution.val
		const pluginCtx = instance.ctx

		// Core responsibility: inject declared config fields before plugin init().
		// Doing it directly avoids an extra event hop on every plugin start.
		try {
			await this.injectConfig(instance)
		} catch (error) {
			const logger = pluginCtx.logger ?? this.ctx.logger
			logger.with({ error }).error`注入/校验配置到 ${String(id)} 失败`
			try {
				await pluginCtx.effects.dispose()
			} catch {
				/* ignored */
			}
			failed.add(id)
			return
		}

		try {
			await this.lifecycle.startLifecycle(id, instance, this.resolveStartTimeoutMs(instance))
		} catch (error) {
			const logger = pluginCtx.logger ?? this.ctx.logger
			logger.with({ error }).error`启动 ${String(id)} 失败`
			try {
				await pluginCtx.effects.dispose()
			} catch {
				/* ignored */
			}
			failed.add(id)
		}
	}

	private async startPlugins(
		container: PluginDiContainer,
		plan: InitPlan,
	): Promise<Set<PluginIdentifier>> {
		return startPluginsWithStrategy(
			plan,
			(id, failed) => this.instantiateAndStart(container, id, failed),
			{ strategy: this.startStrategy, concurrency: this.startConcurrency },
		)
	}

	/**
	 * 非事务化提交：
	 * - 停机：对 remove/replace 逆拓扑停机
	 * - 启动：对 add/replace 拓扑分批启动；失败只影响其依赖链
	 * - 失败插件从 singletons 中清理（下次 commit 仍会尝试重启）
	 */
	async commit() {
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
			action.err.ret.undo()
			this.pruneDetachedSingletons()
			// Diod's ServiceVerificationAggregateError carries a detailed `.toString()` output;
			// include it explicitly because some loggers only print `error.message`.
			this.ctx.logger.with({ error: action.err.err, detail: String(action.err.err) })
				.error`插件在依赖项解析时失败`
			return createErr(action.err.err)
		}

		const { changes, container, confirm } = action.val
		this._activeContainer = container
		try {
			const { added, replaced, removed } = partitionChanges(changes)
			const oldContainer = this.container

			// Normalize restart requests against both old and new containers.
			const restartRequested = new Set(this._pendingRestart)
			this._pendingRestart.clear()

			const restartStop = new Set<PluginIdentifier>()
			const restartStart = new Set<PluginIdentifier>()
			for (const id of restartRequested) {
				const stopKey = this.resolveIdentifier(oldContainer, id)
				if (oldContainer && this.services(oldContainer).has(stopKey)) restartStop.add(stopKey)
				const startKey = this.resolveIdentifier(container, id)
				if (this.services(container).has(startKey)) restartStart.add(startKey)
			}

			const toStop = new Set<PluginIdentifier>()
			for (const id of removed) toStop.add(id)
			for (const id of replaced) toStop.add(id)
			for (const id of restartStop) toStop.add(id)

			const toStart = new Set<PluginIdentifier>()
			for (const id of added) toStart.add(id)
			for (const id of replaced) toStart.add(id)
			for (const id of restartStart) toStart.add(id)

			// Retry previously failed plugins opportunistically on any commit.
			for (const id of this._pendingStart) {
				if (toStop.has(id)) continue
				const key = this.resolveIdentifier(container, id)
				if (this.services(container).has(key)) toStart.add(key)
			}

			// No-op commit: still report state (after applying pending restarts/retries).
			if (changes.length === 0 && toStop.size === 0 && toStart.size === 0) {
				const summary: CommitSummary = {
					container,
					added: [],
					replaced: [],
					removed: [],
					failed: [],
					touched: [],
				}
				this._lastCommit = summary
				this.commitSeq += 1
				this.notifyInstanceWatchers(summary, this.commitSeq)
				this.ctx.emit('afterCommit', summary)
				this.builderSingletons.seal()
				// Keep detached instances: draft mutations may have happened during this commit.
				this.pruneDetachedSingletons()
				return createOk({ container, changes })
			}

			this.ctx.logger.info('插件变更', () => ({
				remove: [...removed].map(String),
				replace: [...replaced].map(String),
				add: [...added].map(String),
				restart: restartRequested.size ? [...restartRequested].map(String) : undefined,
			}))

			await this.applyTeardown(oldContainer, toStop)

			// Ensure fresh instances for restarts/replacements.
			for (const id of toStop) this.builderSingletons.delete(id)
			for (const id of toStop) this.detachedSingletons.delete(id)
			for (const id of replaced) this.builderSingletons.delete(id)
			for (const id of restartStart) this.builderSingletons.delete(id)

			const toInitMap: ServiceMap<BasePlugin> = new Map()
			if (toStart.size) {
				const services = this.services(container)
				// Perf: toStart is usually small (HMR / incremental enables),
				// so index into the service map instead of scanning the whole container.
				for (const serviceId of toStart) {
					const value = services.get(serviceId)
					if (value) toInitMap.set(serviceId, value)
				}
			}

			let failed = new Set<PluginIdentifier>()
			if (toInitMap.size) {
				const plan = computeInitPlan(toInitMap, (id) => this.resolveIdentifier(container, id))
				failed = await this.startPlugins(container, plan)
			}

			confirm()

			// Ensure failed plugins are not observable as "available" for this commit.
			// (They may have been instantiated but not successfully started.)
			if (failed.size) {
				for (const id of failed) this.builderSingletons.delete(id)
				for (const id of failed) this.detachedSingletons.delete(id)
			}

			const summary: CommitSummary = {
				container: this.container!,
				added: [...added],
				replaced: [...replaced],
				removed: [...removed],
				failed: [...failed],
				touched: [...new Set<PluginIdentifier>([...toStop, ...toStart])],
			}
			this._lastCommit = summary
			this.commitSeq += 1
			this.notifyInstanceWatchers(summary, this.commitSeq)
			this.ctx.emit('afterCommit', summary)

			// update pending retry set
			this._pendingStart.clear()
			for (const id of failed) this._pendingStart.add(id)

			if (failed.size) {
				this.ctx.logger.warn('以下插件启动失败', { failed: [...failed].map(String) })
				this.ctx.emit('commitFailed', failed)
			}

			this.builderSingletons.seal()
			// Keep detached instances: draft mutations may have happened during this commit.
			this.pruneDetachedSingletons()
			return createOk({ container: this.container, changes })
		} finally {
			this._activeContainer = undefined
		}
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
