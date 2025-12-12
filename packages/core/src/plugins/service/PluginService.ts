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
import { EffectScopeService } from '../../services/EffectScopeService'
import { BasePlugin, PLUGIN_CTX } from '../BasePlugin'
import { forkPlugin, getForkedCtor, listForks } from '../fork'
import { PluginContainer, type PluginDiContainer } from '../PluginContainer'
import type { PluginInfo } from '../PluginDecorator'
import { getPluginDiKey } from '../PluginDecorator'
import type { ForkablePluginConstructor, PluginConstructor, PluginIdentifier, PluginInstance } from '../types'
import { computeInitPlan, partitionChanges, planTeardown, type InitPlan } from './commitPlanner'
import { LifecycleManager } from './lifecycleManager'
import { OptionalResolver } from './optionalResolver'

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

type OptionalHandler<T> = (
	optional: T | undefined,
	summary: CommitSummary | undefined,
) => void | Promise<void>

type InstancesOf<T extends readonly PluginIdentifier[]> = {
	[K in keyof T]: InstanceType<T[K]> | undefined
}

type OptionalImporter<T extends PluginIdentifier> =
	| Promise<T | T[] | readonly T[]>
	| (() => Promise<T | T[] | readonly T[]>)

type OptionalOptions = {
	watch?: boolean
	multi?: boolean
	onError?: (error: unknown) => void
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
	public pluginRegistry: PluginContainer

	private _commitLock: Promise<unknown> = Promise.resolve()
	private readonly startTimeoutMs: number
	private readonly stopTimeoutMs: number
	private _lastCommit?: CommitSummary
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
		this.pluginRegistry = new PluginContainer(() => {
			const pluginCTX = this.ctx.root.isolate(isolated, { name: `${this.order++}` })

			// Scope is per‑plugin by design and used heavily for disposables.
			// We eagerly instantiate it once and pin it as an own‑property to:
			// 1) avoid repeated Context service‑getter overhead on hot collectEffect calls;
			// 2) keep scope identity stable for this plugin context.
			try {
				const scope = (pluginCTX as any).scope
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
		})

		this.lifecycle = new LifecycleManager(this.ctx, this.startTimeoutMs, this.stopTimeoutMs)
		this.optionals = new OptionalResolver(
			() => this.ctx,
			this.pluginRegistry,
			(id) => this.isRunning(id),
			() => this._lastCommit,
		)
	}

	/* ─────────────────────────── State Query ─────────────────────────── */

	isRunning(id: PluginIdentifier): boolean {
		const key = getPluginDiKey(id)
		const instance = this.pluginRegistry.singletons.get(key as any) as BasePlugin | undefined
		return this.lifecycle.isRunning(instance)
	}

	public get lastCommit(): CommitSummary | undefined {
		return this._lastCommit
	}

	/* ─────────────────────────── Forks ─────────────────────────── */

	/**
	 * Create (or reuse) a fork ctor for a ForkablePlugin.
	 * This does not register it into the container.
	 */
	public fork<T extends ForkablePluginConstructor>(
		ctor: T,
		forkId: string,
	): PluginConstructor {
		return forkPlugin(ctor, forkId)
	}

	/**
	 * Convenience: fork + register into the current draft container.
	 * The fork will be started on the next commit().
	 */
	public registerFork<T extends ForkablePluginConstructor>(
		ctor: T,
		forkId: string,
	): PluginConstructor {
		const ForkCtor = forkPlugin(ctor, forkId)
		this.pluginRegistry.registerPlugin(ForkCtor)
		return ForkCtor
	}

	/** Get a running fork instance if present; otherwise undefined. */
	public getFork<T extends PluginIdentifier>(
		ctor: T,
		forkId: string,
	): InstanceType<T> | undefined {
		const ForkCtor = getForkedCtor(ctor, forkId)
		if (!ForkCtor) return undefined
		return (this.pluginRegistry.lastContainer?.get(ForkCtor as any) ??
			this.pluginRegistry.singletons.get(ForkCtor as any)) as InstanceType<T> | undefined
	}

	/** List all fork ctors created for a given original ctor. */
	public listForks<T extends PluginIdentifier>(ctor: T): PluginConstructor[] {
		return listForks(ctor)
	}

	/* ─────────────────────────── Optional Dependencies ─────────────────────────── */

	public optional<T extends PluginIdentifier>(
		plugin: T,
		handler?: OptionalHandler<InstanceType<T>>,
		opts?: OptionalOptions,
	): InstanceType<T> | undefined
	public optional<T extends PluginIdentifier>(
		importer: OptionalImporter<T>,
		handler?: OptionalHandler<InstanceType<T>>,
		opts?: OptionalOptions & { multi?: false },
	): Promise<InstanceType<T> | undefined>
	public optional<T extends readonly PluginIdentifier[]>(
		importer: Promise<T> | (() => Promise<T>),
		handler: OptionalHandler<InstancesOf<T>>,
		opts: OptionalOptions & { multi: true },
	): Promise<InstancesOf<T> | undefined>
	public optional<T extends PluginIdentifier>(
		importer: OptionalImporter<T>,
		handler: OptionalHandler<Array<InstanceType<T> | undefined>>,
		opts: OptionalOptions & { multi: true },
	): Promise<Array<InstanceType<T> | undefined> | undefined>
	public optional(
		target: PluginIdentifier | OptionalImporter<PluginIdentifier>,
		handler?: OptionalHandler<BasePlugin> | OptionalHandler<BasePlugin[]>,
		opts?: OptionalOptions,
	) {
		return (this.optionals as any).optional(target, handler as any, opts as any)
	}

	public optionalImport<T>(
		importer: () => Promise<T>,
		opts?: { onError?: (error: unknown) => void; label?: string },
	): Promise<T | undefined> {
		return this.optionals.optionalImport(importer, opts)
	}

	/* ─────────────────────────── Commit Internals ─────────────────────────── */

	private async stopPlugin(id: PluginIdentifier, pluginOrUndefined?: BasePlugin): Promise<void> {
		const plugin =
			pluginOrUndefined ??
			(this.pluginRegistry.singletons.get(id as any) as BasePlugin | undefined) ??
			this.pluginRegistry.lastContainer?.get(id)
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
			failed.add(id)
			this.ctx.logger.error(resolution.err, `解析 ${String(id)} 失败`)
			return
		}

		const instance: PluginInstance = resolution.val
		const pluginCtx = instance[PLUGIN_CTX]

		try {
			await this.lifecycle.startLifecycle(id, instance)
		} catch (error) {
			const logger = pluginCtx?.logger ?? this.ctx.logger
			logger?.error?.(error, `启动 ${String(id)} 失败`)
			try {
				await pluginCtx?.scope?.disposeAll?.()
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
		const action = this.pluginRegistry.build()
		if (!action.ok) {
			action.err.ret.undo()
			this.ctx.logger.error(action.err.err, '插件在依赖项解析时失败')
			return createErr(action.err.err)
		}

		const { changes, container, confirm } = action.val

		if (changes.length === 0) {
			const summary: CommitSummary = {
				container,
				added: [],
				replaced: [],
				removed: [],
				failed: [],
			}
			this._lastCommit = summary
			this.ctx.emit('afterCommit', summary)
			return createOk({ container, changes })
		}

		const { added, replaced, removed } = partitionChanges(changes)
		this.ctx.logger.info(
			{
				remove: [...removed].map(String),
				replace: [...replaced].map(String),
				add: [...added].map(String),
			},
			'插件变更',
		)

		const oldContainer = this.pluginRegistry.lastContainer
		const toStop = new Set([...removed, ...replaced])
		const toStart = new Set([...added, ...replaced])

		await this.applyTeardown(oldContainer, toStop)

		const toInitMap: ServiceMap<BasePlugin> = new Map()
		if (toStart.size) {
			for (const [serviceId, value] of container.services) {
				if (toStart.has(serviceId as PluginIdentifier)) {
					toInitMap.set(serviceId as PluginIdentifier, value)
				}
			}
		}

		let failed = new Set<PluginIdentifier>()
		if (toInitMap.size) {
			const plan = computeInitPlan(toInitMap)
			failed = await this.startPlugins(container, plan)
		}

		confirm()

		const summary: CommitSummary = {
			container: this.pluginRegistry.lastContainer,
			added: [...added],
			replaced: [...replaced],
			removed: [...removed],
			failed: [...failed],
		}
		this._lastCommit = summary
		this.ctx.emit('afterCommit', summary)

		if (failed.size) {
			for (const id of failed) this.pluginRegistry.singletons.delete(id)
			this.ctx.logger.warn({ failed: [...failed].map(String) }, '以下插件启动失败')
			this.ctx.emit('commitFailed', failed)
		}

		return createOk({ container: this.pluginRegistry.lastContainer, changes })
	}
}
