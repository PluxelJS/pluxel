// PluginService.ts

import type { Context, ServiceClass } from '@pluxel/context'
import { Injectable } from '@pluxel/context'
import { createErr, createOk } from 'option-t/plain_result'
import type { ServiceMap } from '../container'
import { EffectScopeService } from '../services/EffectScopeService'
import { BasePlugin, PLUGIN_CTX } from './BasePlugin'
import { PluginContainer, type PluginDiContainer } from './PluginContainer'
import type { PluginInfo } from './PluginDecorator'
import { type LifecycleSnapshot, lifecycleSelectors, PluginLifecycleActor } from './pluginActor'
import type { PluginIdentifier, PluginInstance } from './types'

const PLUGIN_LIFECYCLE = Symbol.for('pluxel:plugin:lifecycle')

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

type InitPlan = {
	batches: PluginIdentifier[][]
	leftovers: Set<PluginIdentifier>
	dependencies: Map<PluginIdentifier, readonly PluginIdentifier[]>
}

/* ─────────────────────────── Helpers ─────────────────────────── */

const isPluginIdentifier = (v: unknown): v is PluginIdentifier =>
	typeof v === 'function' && v.prototype instanceof BasePlugin

const describeIds = (ids: PluginIdentifier[]) =>
	ids.map((id) => String((id as any)?.name ?? id)).join(', ')

const arraysEqual = <T>(a: T[], b: T[]): boolean => {
	if (a.length !== b.length) return false
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false
	}
	return true
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

	/** caller -> (pluginId -> wrapped view) 缓存 */
	private optionalViews = new WeakMap<
		Context,
		Map<PluginIdentifier, { source: BasePlugin; view: BasePlugin }>
	>()

	constructor(
		private ctx: Context,
		config: PluginServiceConfig,
	) {
		this.startTimeoutMs = config?.startTimeoutMs ?? 1_500
		this.stopTimeoutMs = config?.stopTimeoutMs ?? 3_000

		const isolated = [...new Set([...(config?.pluginCTXIsolate ?? []), EffectScopeService])]
		this.pluginRegistry = new PluginContainer(() =>
			this.ctx.root.isolate(isolated, { name: `${this.order++}` }),
		)
	}

	/* ─────────────────────────── Lifecycle Slot ─────────────────────────── */

	private ensureLifecycleSlot(plugin: BasePlugin): {
		[PLUGIN_LIFECYCLE]: PluginLifecycleActor | null
	} {
		if (!Object.hasOwn(plugin, PLUGIN_LIFECYCLE)) {
			Object.defineProperty(plugin, PLUGIN_LIFECYCLE, {
				value: null,
				writable: true,
				configurable: false,
				enumerable: false,
			})
		}
		return plugin as any
	}

	private getLifecycle(plugin: BasePlugin): PluginLifecycleActor | undefined {
		return this.ensureLifecycleSlot(plugin)[PLUGIN_LIFECYCLE] ?? undefined
	}

	private setLifecycle(plugin: BasePlugin, ref?: PluginLifecycleActor) {
		this.ensureLifecycleSlot(plugin)[PLUGIN_LIFECYCLE] = ref ?? null
	}

	private createLifecycle(id: PluginIdentifier, plugin: BasePlugin): PluginLifecycleActor {
		const ref = new PluginLifecycleActor(
			{ autoStart: false, useErrorChannel: true },
			{ id, runtime: BasePlugin.getLifecycleRuntime(plugin) },
		)
		ref.subscribe({
			error: (err) =>
				this.ctx.logger?.error?.(err, `[actor:${String((id as any)?.name ?? id)}] unhandled error`),
		})
		ref.start()
		this.setLifecycle(plugin, ref)
		return ref
	}

	private ensureLifecycle(id: PluginIdentifier, plugin: BasePlugin): PluginLifecycleActor {
		const existing = this.getLifecycle(plugin)
		if (existing) {
			if (!lifecycleSelectors.isStopped(existing.getSnapshot?.())) return existing
			this.setLifecycle(plugin)
		}
		return this.createLifecycle(id, plugin)
	}

	/* ─────────────────────────── State Query ─────────────────────────── */

	isRunning(id: PluginIdentifier): boolean {
		const instance = this.pluginRegistry.singletons.get(id as any) as BasePlugin | undefined
		if (!instance) return false
		return lifecycleSelectors.isRunning(this.getLifecycle(instance)?.getSnapshot?.())
	}

	public get lastCommit(): CommitSummary | undefined {
		return this._lastCommit
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
		const callerCtx = this.ctx
		const watch = opts?.watch ?? true
		const multi = opts?.multi ?? false

		// Async import path
		if (!isPluginIdentifier(target)) {
			const importer = typeof target === 'function' ? target : () => target
			const label = importer.name || 'dynamic import'

			return this.optionalImport(importer, { onError: opts?.onError, label }).then((mod) => {
				if (mod === undefined) {
					return this.invokeOptionalHandler(handler, undefined, this._lastCommit, label, multi)
				}

				const ids = this.normalizePluginIdentifiers(mod)
				if (!ids.length) {
					const err = new Error(`optional(${label}) 未找到 BasePlugin 导出`)
					this.ctx.logger?.warn?.(err)
					opts?.onError?.(err)
					return Promise.resolve(
						this.invokeOptionalHandler(handler, undefined, this._lastCommit, label, multi),
					).then(() => (multi ? [] : undefined))
				}

				const payload = this.collectOptionals(ids, callerCtx, multi)
				if (!payload.length || payload.every((item) => item === undefined)) {
					this.logUnavailable(ids, label)
				}
				if (handler) {
					void this.invokeOptionalHandler(handler, payload, this._lastCommit, label, multi)
				}
				if (watch && handler) {
					this.attachOptionalWatcher(ids, callerCtx, handler, label, multi, multi)
				}
				return (multi ? payload : payload[0]) as any
			})
		}

		// Sync path
		const ids = [target]
		const label = describeIds(ids)
		const payload = this.collectOptionals(ids, callerCtx, false)
		if (!payload.length) this.logUnavailable(ids, label)
		void this.invokeOptionalHandler(handler, payload, this._lastCommit, label, false)
		if (watch && handler) {
			this.attachOptionalWatcher(ids, callerCtx, handler, label, false, false)
		}
		return payload[0] as any
	}

	public async optionalImport<T>(
		importer: () => Promise<T>,
		opts?: { onError?: (error: unknown) => void; label?: string },
	): Promise<T | undefined> {
		try {
			return await importer()
		} catch (error) {
			if (opts?.onError) {
				opts.onError(error)
			} else {
				const name = (opts?.label ?? importer.name) || 'optionalImport'
				this.ctx.logger?.warn?.(error, `${name} 动态导入失败`)
			}
			return undefined
		}
	}

	private collectOptionals(
		ids: PluginIdentifier[],
		callerCtx: Context,
		keepGaps: boolean,
	): Array<BasePlugin | undefined> {
		const result = ids.map((id) => this.getRunningOptional(id, callerCtx))
		return keepGaps ? result : result.filter((x): x is BasePlugin => x !== undefined)
	}

	private invokeOptionalHandler(
		handler: OptionalHandler<BasePlugin> | OptionalHandler<BasePlugin[]> | undefined,
		payload: Array<BasePlugin | undefined> | undefined,
		summary: CommitSummary | undefined,
		label: string,
		asMulti: boolean,
	) {
		if (!handler) return
		const value = (asMulti ? (payload ?? []) : payload?.[0]) as any
		return Promise.resolve(handler(value, summary)).catch((error) => {
			this.ctx.logger?.error?.(error, `optional(${label}) 处理失败`)
		})
	}

	private logUnavailable(ids: PluginIdentifier[], label: string) {
		const container = this.pluginRegistry.lastContainer
		const missingInContainer = ids.filter((id) => !container?.services?.has(id))
		if (missingInContainer.length) {
			this.ctx.logger?.warn?.(
				{ plugins: missingInContainer.map(String) },
				`optional(${label}) 未在容器中，可能尚未注册`,
			)
			return
		}
		const notRunning = ids.filter((id) => !this.isRunning(id))
		if (notRunning.length) {
			this.ctx.logger?.info?.(
				{ plugins: notRunning.map(String) },
				`optional(${label}) 已注册但未运行`,
			)
		}
	}

	private attachOptionalWatcher(
		ids: PluginIdentifier[],
		callerCtx: Context,
		handler: OptionalHandler<BasePlugin> | OptionalHandler<BasePlugin[]>,
		label: string,
		asMulti: boolean,
		keepGaps: boolean,
	) {
		let last = this.collectOptionals(ids, callerCtx, keepGaps)
		// optional 应该只管一次 commit，毕竟 optional 只会在 commit 后执行，执行后马上取消监听。
		this.ctx.events.once('afterCommit', (summary) => {
			const current = this.collectOptionals(ids, callerCtx, keepGaps)
			if (arraysEqual(last, current)) return
			last = current
			if (!current.length || current.every((item) => item === undefined)) {
				this.logUnavailable(ids, label)
			}
			void this.invokeOptionalHandler(handler as any, current, summary, label, asMulti)
		})
	}

	private getRunningOptional<T extends PluginIdentifier>(
		ctor: T,
		callerCtx: Context,
	): InstanceType<T> | undefined {
		if (!this.isRunning(ctor)) {
			this.optionalViews.get(callerCtx)?.delete(ctor)
			return undefined
		}

		const instance = this.pluginRegistry.singletons.get(ctor as any) as InstanceType<T> | undefined
		if (!instance) {
			this.optionalViews.get(callerCtx)?.delete(ctor)
			return undefined
		}

		let map = this.optionalViews.get(callerCtx)
		const cached = map?.get(ctor)
		if (cached && cached.source === instance) return cached.view as InstanceType<T>

		const wrapped = this.wrapWithCaller(instance, callerCtx) as InstanceType<T>
		if (!map) {
			map = new Map()
			this.optionalViews.set(callerCtx, map)
		}
		map.set(ctor, { source: instance, view: wrapped })
		return wrapped
	}

	private wrapWithCaller<P extends BasePlugin>(instance: P, callerCtx: Context): P {
		const view = Object.create((instance as any)[PLUGIN_CTX])
		view.caller = callerCtx
		return Object.create(instance, {
			ctx: { value: view, writable: false, enumerable: false, configurable: false },
		})
	}

	private normalizePluginIdentifiers(input: unknown): PluginIdentifier[] {
		if (isPluginIdentifier(input)) return [input]
		if (Array.isArray(input)) return input.filter(isPluginIdentifier)
		return []
	}

	/* ─────────────────────────── Topo Utils ─────────────────────────── */

	private computeInitPlan(plugins: ServiceMap<BasePlugin>): InitPlan {
		const inDegree = new Map<PluginIdentifier, number>()
		const graph = new Map<PluginIdentifier, PluginIdentifier[]>()
		const dependencies = new Map<PluginIdentifier, readonly PluginIdentifier[]>()

		for (const id of plugins.keys()) {
			inDegree.set(id, 0)
			graph.set(id, [])
		}

		for (const [id, plugin] of plugins) {
			const deps = (plugin.dependencies ?? []) as PluginIdentifier[]
			dependencies.set(id, deps)
			for (const dep of deps) {
				if (!inDegree.has(dep)) continue
				inDegree.set(id, inDegree.get(id)! + 1)
				graph.get(dep)!.push(id)
			}
		}

		const batches: PluginIdentifier[][] = []
		let frontier: PluginIdentifier[] = []
		for (const [id, degree] of inDegree) {
			if (degree === 0) frontier.push(id)
		}

		while (frontier.length) {
			batches.push(frontier)
			const next: PluginIdentifier[] = []
			for (const current of frontier) {
				for (const dependent of graph.get(current)!) {
					const remaining = inDegree.get(dependent)! - 1
					inDegree.set(dependent, remaining)
					if (remaining === 0) next.push(dependent)
				}
			}
			frontier = next
		}

		const leftovers = new Set<PluginIdentifier>()
		for (const [id, degree] of inDegree) {
			if (degree > 0) leftovers.add(id)
		}

		return { batches, leftovers, dependencies }
	}

	private planTeardown(
		dependents: ReadonlyMap<PluginIdentifier, Set<PluginIdentifier>> | undefined,
		affected: Set<PluginIdentifier>,
	): PluginIdentifier[] {
		if (!dependents || affected.size === 0) return []

		const remainingChildren = new Map<PluginIdentifier, number>()
		const parents = new Map<PluginIdentifier, PluginIdentifier[]>()

		for (const id of affected) {
			remainingChildren.set(id, 0)
			parents.set(id, [])
		}

		for (const id of affected) {
			const children = dependents.get(id)
			if (!children) continue
			for (const child of children) {
				if (!affected.has(child)) continue
				remainingChildren.set(id, (remainingChildren.get(id) ?? 0) + 1)
				parents.get(child)!.push(id)
			}
		}

		const order: PluginIdentifier[] = []
		const stack: PluginIdentifier[] = []
		for (const [id, count] of remainingChildren) {
			if (count === 0) stack.push(id)
		}

		while (stack.length) {
			const current = stack.pop()!
			order.push(current)
			for (const parent of parents.get(current)!) {
				const next = (remainingChildren.get(parent) ?? 0) - 1
				remainingChildren.set(parent, next)
				if (next === 0) stack.push(parent)
			}
		}

		for (const [id, count] of remainingChildren) {
			if (count > 0) order.push(id)
		}
		return order
	}

	/* ─────────────────────────── Lifecycle Management ─────────────────────────── */

	private async startLifecycle(id: PluginIdentifier, plugin: BasePlugin): Promise<void> {
		const ref = this.ensureLifecycle(id, plugin)
		if (lifecycleSelectors.isRunning(ref.getSnapshot?.())) return

		ref.send({ type: 'START' })

		let snapshot: LifecycleSnapshot
		try {
			snapshot = await ref.waitForStable(this.startTimeoutMs)
		} catch (error) {
			await this.stopLifecycle(id, plugin, ref)
			throw new Error(`Plugin ${String(id)} start timeout after ${this.startTimeoutMs}ms`, {
				cause: error,
			})
		}

		if (lifecycleSelectors.isRunning(snapshot)) return

		const capturedErr: unknown =
			(ref.getSnapshot?.() as any)?.context?.err ??
			(snapshot as any)?.context?.err ??
			(snapshot as any)?.error

		await this.stopLifecycle(id, plugin, ref)

		if (capturedErr instanceof Error) throw capturedErr
		if (capturedErr != null) throw new Error(String(capturedErr), { cause: capturedErr })
		throw new Error(`Plugin ${String(id)} failed to start`)
	}

	private async stopLifecycle(
		id: PluginIdentifier,
		plugin: BasePlugin,
		ref?: PluginLifecycleActor,
	): Promise<void> {
		const lifecycle = ref ?? this.getLifecycle(plugin)
		if (!lifecycle) return

		try {
			lifecycle.send({ type: 'STOP' })
		} catch {
			/* ignore */
		}

		await this.waitUntilStopped(lifecycle)
		this.setLifecycle(plugin)
	}

	private async waitUntilStopped(ref: PluginLifecycleActor): Promise<void> {
		if (lifecycleSelectors.isStopped(ref.getSnapshot?.())) return
		try {
			await ref.waitForStopped(this.stopTimeoutMs)
		} catch {
			/* ignore */
		}
	}

	private async stopPlugin(id: PluginIdentifier, pluginOrUndefined?: BasePlugin): Promise<void> {
		const plugin =
			pluginOrUndefined ??
			(this.pluginRegistry.singletons.get(id as any) as BasePlugin | undefined) ??
			this.pluginRegistry.lastContainer?.get(id)
		if (!plugin) return
		await this.stopLifecycle(id, plugin)
	}

	/* ─────────────────────────── Commit ─────────────────────────── */

	private partitionChanges(changes: Array<{ type: string; key: unknown }>) {
		const added = new Set<PluginIdentifier>()
		const replaced = new Set<PluginIdentifier>()
		const removed = new Set<PluginIdentifier>()

		for (const { type, key } of changes) {
			const id = key as PluginIdentifier
			if (type === 'add') added.add(id)
			else if (type === 'replace') replaced.add(id)
			else removed.add(id)
		}

		return { added, replaced, removed }
	}

	private async applyTeardown(
		container: PluginDiContainer | undefined,
		toStop: Set<PluginIdentifier>,
	): Promise<void> {
		if (!container || toStop.size === 0) return
		const order = this.planTeardown(container.dependents, toStop)
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
			await this.startLifecycle(id, instance)
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
	 * - 失败插件从 singletons 中清理
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

		const { added, replaced, removed } = this.partitionChanges(changes)
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
			const plan = this.computeInitPlan(toInitMap)
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
