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
import { EffectScopeService } from '../../services/EffectScopeService'
import { BasePlugin } from '../BasePlugin'
import { forkPlugin, getForkedCtor, listForks } from '../fork'
import { PluginDefinitions, type PluginDiContainer } from '../PluginDefinitions'
import type { PluginInfo } from '../PluginDecorator'
import type {
	ForkablePluginConstructor,
	PluginConstructor,
	PluginIdentifier,
	PluginInstance,
} from '../types'
import { computeInitPlan, partitionChanges, planTeardown, type InitPlan } from './commitPlanner'
import { LifecycleManager } from './lifecycleManager'
import {
	type InstancesOf,
	type OptionalEffectHandler,
	type OptionalEffectOptions as OptionalSubscriptionOptions,
	type OptionalImporter,
	OptionalResolver,
} from './optionalResolver'

/* ─────────────────────────── Types ─────────────────────────── */

type PluginServiceConfig = {
	pluginCTXIsolate?: ServiceClass<any>[]
	startTimeoutMs?: number
	stopTimeoutMs?: number
}

export interface CommitSummary {
	container: PluginDiContainer
	added: PluginIdentifier[]
	replaced: PluginIdentifier[]
	removed: PluginIdentifier[]
	failed: PluginIdentifier[]
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
		[serviceName]: PluginService
		pluginInfo: PluginInfo
		parent?: Context
		caller?: Context
	}
}

/* ─────────────────────────── Service ─────────────────────────── */

@Injectable({ key: serviceName })
export class PluginService {
	private readonly definitions: PluginDefinitions
	private readonly builderSingletons = new LeanMapTracker<PluginIdentifier, PluginInstance>()

	private _commitLock: Promise<unknown> = Promise.resolve()
	private readonly startTimeoutMs: number
	private readonly stopTimeoutMs: number
	private _lastCommit?: CommitSummary
	/** Active draft container during commit() before confirm(). */
	private _activeContainer?: PluginDiContainer
	/** Plugins that should be (re)started on the next commit. */
	private _pendingStart = new Set<PluginIdentifier>()
	/** Plugins that should be restarted (re-instantiated) on the next commit. */
	private _pendingRestart = new Set<PluginIdentifier>()
	private order = 0

	// Internal helpers (single instances; no per‑commit allocations).
	private readonly lifecycle: LifecycleManager
	private readonly optionals: OptionalResolver

	constructor(
		private ctx: Context,
		config: PluginServiceConfig,
	) {
		this.startTimeoutMs = config?.startTimeoutMs ?? 1_500
		this.stopTimeoutMs = config?.stopTimeoutMs ?? 3_000

		const isolated = [...new Set([...(config?.pluginCTXIsolate ?? []), EffectScopeService])]
		this.definitions = new PluginDefinitions(() => {
			const pluginCTX = this.ctx.root.isolate(isolated, { name: `${this.order++}` })

			// Scope is per‑plugin by design and used heavily for disposables.
			// We eagerly instantiate it once and pin it as an own‑property to:
			// 1) avoid repeated Context service‑getter overhead on hot collectEffect calls;
			// 2) keep scope identity stable for this plugin context.
			try {
				const scope = pluginCTX.scope
				if (scope) {
					Object.defineProperty(pluginCTX, 'scope', {
						value: scope,
						writable: false,
						enumerable: false,
						configurable: true,
					})
				}
			} catch {
				// If scope service was overridden/removed, fall back silently.
			}

			return pluginCTX
		}, this.builderSingletons)

		this.lifecycle = new LifecycleManager(this.ctx, this.startTimeoutMs, this.stopTimeoutMs)
		this.optionals = new OptionalResolver(
			() => this.ctx,
			() => this.container,
			() => this.builderSingletons,
			(id) => this.isRunning(id),
			() => this._lastCommit,
			() => this._activeContainer,
		)
	}

	private injectConfig(plugin: PluginInstance): void {
		const pluginCtx = plugin.ctx
		const info: PluginInfo = pluginCtx.pluginInfo
		const schemaMap = info.configMap as Record<string, unknown> | null | undefined
		if (!schemaMap) return

		const id = info.id

		const record = pluginCtx.configService.getConfigSnapshot(id)?.configRecord ?? {}

		for (const key of Object.keys(schemaMap)) {
			;(plugin as any)[key] = (record as any)[key]
		}
	}

	/* ─────────────────────────── State Query ─────────────────────────── */

	isRunning(id: PluginIdentifier): boolean {
		const container = this._activeContainer ?? this.container
		const key = container?.resolveIdentifier?.(id as any) ?? id
		const instance = this.builderSingletons.get(key as any) as BasePlugin | undefined
		return this.lifecycle.isRunning(instance)
	}

	public get lastCommit(): CommitSummary | undefined {
		return this._lastCommit
	}

	/**
	 * Get the current singleton instance for an identifier if it was constructed.
	 * This does not instantiate or start anything; it only reads the runtime cache.
	 */
	public getInstance<T extends PluginIdentifier>(id: T): InstanceType<T> | undefined {
		const container = this._activeContainer ?? this.container
		const key = (container?.resolveIdentifier?.(id as any) ?? id) as PluginIdentifier
		return this.builderSingletons.get(key as any) as InstanceType<T> | undefined
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
		return (this.container?.get(ForkCtor as any) ?? this.builderSingletons.get(ForkCtor as any)) as
			| InstanceType<T>
			| undefined
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
		const resolve = (id: PluginIdentifier) =>
			(container.resolveIdentifier?.(id as any) ?? id) as PluginIdentifier

		const affected = new Set<PluginIdentifier>()
		const stack: PluginIdentifier[] = []
		for (const r of roots) stack.push(resolve(r))

		while (stack.length) {
			const current = stack.pop()!
			if (affected.has(current)) continue
			affected.add(current)
			const children = container.dependents.get(current)
			if (!children) continue
			for (const dep of children) stack.push(resolve(dep as any))
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
		for (const t of targets) this.definitions.unregister(t)
		for (const t of targets) {
			this._pendingStart.delete(t)
			this._pendingRestart.delete(t)
		}
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
			if (
				container &&
				!container.services.has((container.resolveIdentifier?.(t as any) ?? t) as any)
			) {
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
		const canonical = (container?.resolveIdentifier?.(target as any) ?? target) as PluginIdentifier
		const targets =
			(opts?.cascadeDependents ?? true)
				? this.collectDependents(container, [canonical])
				: new Set([canonical])

		// Update declaration layer: unregister old provider and register new one with aliases.
		this.definitions.unregister(canonical)
		this.definitions.register(next, {
			provideBase: opts?.provideBase,
			aliases: [target, canonical],
		})

		// Runtime intent: restart affected plugins so they observe the new provider instance.
		for (const t of targets) this._pendingRestart.add(t)
	}

	/* ─────────────────────────── Optional Dependencies ─────────────────────────── */

	/**
	 * The ONLY supported optional dependency API:
	 * - returns a disposer (also collected into caller ctx.scope)
	 * - effect is executed on "settled" state (afterCommit when called during commit())
	 */
	public optional<T extends PluginIdentifier>(
		plugin: T,
		effect: OptionalEffectHandler<InstanceType<T> | undefined>,
		opts?: OptionalSubscriptionOptions & { multi?: false },
	): () => void
	public optional<T extends readonly PluginIdentifier[]>(
		plugins: T,
		effect: OptionalEffectHandler<InstancesOf<T>>,
		opts: OptionalSubscriptionOptions & { multi: true },
	): () => void
	public optional<T extends PluginIdentifier>(
		importer: OptionalImporter<T>,
		effect: OptionalEffectHandler<InstanceType<T> | undefined>,
		opts?: OptionalSubscriptionOptions & { multi?: false },
	): Promise<() => void>
	public optional<T extends PluginIdentifier>(
		importer: OptionalImporter<T>,
		effect: OptionalEffectHandler<Array<InstanceType<T> | undefined>>,
		opts: OptionalSubscriptionOptions & { multi: true },
	): Promise<() => void>
	public optional(
		target: PluginIdentifier | OptionalImporter<PluginIdentifier> | readonly PluginIdentifier[],
		effect: OptionalEffectHandler<BasePlugin | Array<BasePlugin | undefined> | undefined>,
		opts?: OptionalSubscriptionOptions,
	) {
		return (this.optionals as any).optional(target, effect, opts)
	}

	/* ─────────────────────────── Commit Internals ─────────────────────────── */

	private async stopPlugin(id: PluginIdentifier, pluginOrUndefined?: BasePlugin): Promise<void> {
		const plugin =
			pluginOrUndefined ??
			(this.builderSingletons.get(id as any) as BasePlugin | undefined) ??
			this.container?.get(id)
		if (!plugin) return
		await this.lifecycle.stopLifecycle(id, plugin)
	}

	private async applyTeardown(
		container: PluginDiContainer | undefined,
		toStop: Set<PluginIdentifier>,
	): Promise<void> {
		if (!container || toStop.size === 0) return
		const order = planTeardown(container.dependents, toStop)
		for (const id of order) {
			const instance = container.get(id)
			if (instance) await this.stopPlugin(id, instance)
		}
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
			this.ctx.logger.error(err, `解析 ${String(id)} 失败`)
			return
		}

		const instance: PluginInstance = resolution.val
		const pluginCtx = instance.ctx

		// Core responsibility: inject @Config fields before plugin init().
		// Doing it directly avoids an extra event hop on every plugin start.
		try {
			this.injectConfig(instance)
		} catch (error) {
			const logger = pluginCtx.logger ?? this.ctx.logger
			logger.warn(error, `注入配置到 ${String(id)} 失败`)
		}

		try {
			await this.lifecycle.startLifecycle(id, instance)
		} catch (error) {
			const logger = pluginCtx.logger ?? this.ctx.logger
			logger.error(error, `启动 ${String(id)} 失败`)
			try {
				await pluginCtx.scope.disposeAll()
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
		const failed = new Set<PluginIdentifier>(plan.leftovers)
		const { dependencies } = plan

		for (const batch of plan.batches) {
			const tasks: Promise<void>[] = []
			for (const id of batch) {
				if (failed.has(id)) continue

				const deps = dependencies.get(id) ?? []
				if (deps.some((dep) => failed.has(dep))) {
					failed.add(id)
					continue
				}

				tasks.push(this.instantiateAndStart(container, id, failed))
			}

			if (tasks.length) await Promise.all(tasks)
		}

		return failed
	}

	/**
	 * 非事务化提交：
	 * - 停机：对 remove/replace 逆拓扑停机
	 * - 启动：对 add/replace 拓扑分批启动；失败只影响其依赖链
	 * - 失败插件从 singletons 中清理（下次 commit 仍会尝试重启）
	 */
	async commit() {
		const next = this._commitLock
			.then(() => this.executeCommit())
			.catch((error) => {
				this.ctx.logger.error(error, 'commit 内部异常')
				return createErr(error)
			})

		this._commitLock = next
		return next
	}

	private async executeCommit() {
		const action = this.definitions.build()
		if (!action.ok) {
			action.err.ret.undo()
			this.ctx.logger.error(action.err.err, '插件在依赖项解析时失败')
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
				const stopKey = (oldContainer?.resolveIdentifier?.(id as any) ?? id) as PluginIdentifier
				if (oldContainer?.services.has(stopKey as any)) restartStop.add(stopKey)
				const startKey = (container.resolveIdentifier?.(id as any) ?? id) as PluginIdentifier
				if (container.services.has(startKey as any)) restartStart.add(startKey)
			}

			const toStop = new Set<PluginIdentifier>([...removed, ...replaced, ...restartStop])
			const toStart = new Set<PluginIdentifier>([...added, ...replaced, ...restartStart])

			// Retry previously failed plugins opportunistically on any commit.
			for (const id of this._pendingStart) {
				if (toStop.has(id)) continue
				const key = container.resolveIdentifier?.(id as any) ?? id
				if (container.services.has(key as any)) toStart.add(key as PluginIdentifier)
			}

			// No-op commit: still report state (after applying pending restarts/retries).
			if (changes.length === 0 && toStop.size === 0 && toStart.size === 0) {
				const summary: CommitSummary = {
					container,
					added: [],
					replaced: [],
					removed: [],
					failed: [],
				}
				this._lastCommit = summary
				this.ctx.emit('afterCommit', summary)
				this.builderSingletons.seal()
				return createOk({ container, changes })
			}

			this.ctx.logger.info(
				{
					remove: [...removed].map(String),
					replace: [...replaced].map(String),
					add: [...added].map(String),
					restart: restartRequested.size ? [...restartRequested].map(String) : undefined,
				},
				'插件变更',
			)

			await this.applyTeardown(oldContainer, toStop)

			// Ensure fresh instances for restarts/replacements.
			for (const id of toStop) this.builderSingletons.delete(id as any)
			for (const id of [...replaced, ...restartStart]) this.builderSingletons.delete(id as any)

			const toInitMap: ServiceMap<BasePlugin> = new Map()
			if (toStart.size) {
				// Perf: toStart is usually small (HMR / incremental enables),
				// so index into the service map instead of scanning the whole container.
				for (const serviceId of toStart) {
					const value = container.services.get(serviceId as any)
					if (value) toInitMap.set(serviceId as PluginIdentifier, value)
				}
			}

			let failed = new Set<PluginIdentifier>()
			if (toInitMap.size) {
				const plan = computeInitPlan(
					toInitMap,
					(id) => container.resolveIdentifier?.(id as any) ?? id,
				)
				failed = await this.startPlugins(container, plan)
			}

			confirm()

			const summary: CommitSummary = {
				container: this.container!,
				added: [...added],
				replaced: [...replaced],
				removed: [...removed],
				failed: [...failed],
			}
			this._lastCommit = summary
			this.ctx.emit('afterCommit', summary)

			// update pending retry set
			this._pendingStart.clear()
			for (const id of failed) this._pendingStart.add(id)

			if (failed.size) {
				for (const id of failed) this.builderSingletons.delete(id as any)
				this.ctx.logger.warn({ failed: [...failed].map(String) }, '以下插件启动失败')
				this.ctx.emit('commitFailed', failed)
			}

			this.builderSingletons.seal()
			return createOk({ container: this.container, changes })
		} finally {
			this._activeContainer = undefined
		}
	}
}
