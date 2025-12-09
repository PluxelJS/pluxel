// PluginService.ts

import type { Context, ServiceClass } from '@pluxel/context'
import { Injectable } from '@pluxel/context'
import { createErr, createOk } from 'option-t/plain_result'
import type { ServiceMap } from '../container'
import { EffectScopeService } from '../services/EffectScopeService'
import { BasePlugin, PLUGIN_CTX } from './BasePlugin'
import { PluginContainer, type PluginDiContainer } from './PluginContainer'
import type { PluginInfo } from './PluginDecorator'
import {
	createPluginLifecycle,
	type PluginLifecycleRef,
} from './pluginActor'
import type { PluginIdentifier, PluginInstance } from './types'

type PluginServiceConfig = {
	plugigCTXIsolate?: ServiceClass<any>[]
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

type LifecycleSnapshot = ReturnType<PluginLifecycleRef['getSnapshot']>

type InitPlan = {
	batches: PluginIdentifier[][]
	leftovers: Set<PluginIdentifier>
	dependencies: Map<PluginIdentifier, readonly PluginIdentifier[]>
}

const isStoppedSnapshot = (snapshot: LifecycleSnapshot): boolean =>
	!!snapshot && (snapshot.status === 'stopped' || snapshot.value === 'stopped')

const isRunningSnapshot = (snapshot: LifecycleSnapshot): boolean =>
	!!snapshot && snapshot.value === 'running'

const isStableSnapshot = (snapshot: LifecycleSnapshot): boolean => {
	if (!snapshot) return false
	const v = snapshot.value
	return v === 'running' || v === 'failing' || v === 'stopped'
}

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

@Injectable({ key: serviceName })
export class PluginService {
	// 容器：负责“构造实例 + 注入 ctx”；生命周期全由 XState 负责
	public pluginRegistry: PluginContainer

	/** 每个插件一个生命周期 actor（唯一真相来源） */
	private readonly actors = new WeakMap<PluginIdentifier, PluginLifecycleRef>()

	private readonly lifecycleFactory = createPluginLifecycle({
		autoStart: false,
		useErrorChannel: true,
	})

	/** 串行化 commit */
	private _commitLock: Promise<unknown> = Promise.resolve()

	/** 可调等待超时（毫秒） */
	private readonly startTimeoutMs
	private readonly stopTimeoutMs
	private _lastCommit?: CommitSummary
	private order = 0
	/** caller -> (pluginId -> wrapped view) 缓存，保证 optional 返回的实例在 caller 侧稳定 */
	private optionalViews = new WeakMap<
		Context,
		Map<PluginIdentifier, { source: BasePlugin; view: BasePlugin }>
	>()
	private readonly wrapOptionalWithCaller = (() => {
		const desc: PropertyDescriptor = {
			value: null,
			writable: false,
			enumerable: false,
			configurable: false,
		}
		return <P extends BasePlugin>(instance: P, callerCtx: Context): P => {
			const view = Object.create((instance as any)[PLUGIN_CTX])
			view.caller = callerCtx
			desc.value = view
			const injected = Object.create(instance, { ctx: desc })
			desc.value = null
			return injected
		}
	})()
	constructor(
		private ctx: Context,
		config: PluginServiceConfig,
	) {
		this.startTimeoutMs = config?.startTimeoutMs ?? 1_500
		this.stopTimeoutMs = config?.stopTimeoutMs ?? 3_000

		const isolated = Array.from(new Set([...(config?.plugigCTXIsolate ?? []), EffectScopeService]))
		this.pluginRegistry = new PluginContainer(() =>
			this.ctx.root.isolate(isolated, { name: `${this.order++}` }),
		)
	}

	/* ------------------------------ 状态查询 ------------------------------ */

	isRunning(id: PluginIdentifier): boolean {
		const ref = this.actors.get(id)
		const snapshot = ref?.getSnapshot()
		if (snapshot === undefined) return false
		return isRunningSnapshot(snapshot)
	}

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
		const isPluginIdentifier = (v: unknown): v is PluginIdentifier =>
			typeof v === 'function' && v.prototype instanceof BasePlugin

			const watch = opts?.watch ?? true
			const multi = opts?.multi ?? false
			const describe = (ids: PluginIdentifier[]) =>
				ids.map((id) => String((id as any)?.name ?? id)).join(', ')
			const collectWithGaps = <P extends PluginIdentifier>(ids: P[]) =>
				ids.map((id) => this.getRunningOptional(id, callerCtx))
			const collectCompact = <P extends PluginIdentifier>(ids: P[]) =>
				collectWithGaps(ids).filter((x): x is InstanceType<P> => x !== undefined)
			const hasChanged = (
				prev: Array<BasePlugin | undefined>,
				next: Array<BasePlugin | undefined>,
			) => {
				if (prev.length !== next.length) return true
				for (let i = 0; i < next.length; i++) {
					if (prev[i] !== next[i]) return true
				}
				return false
			}
			const invokeHandler = (
				handlerFn: OptionalHandler<BasePlugin> | OptionalHandler<BasePlugin[]> | undefined,
				payload: Array<BasePlugin | undefined> | undefined,
				summary: CommitSummary | undefined,
				label: string,
				asMulti: boolean,
			) => {
				if (!handlerFn) return
			const value = (asMulti ? payload ?? [] : payload?.[0]) as any
			return Promise.resolve(handlerFn(value, summary)).catch((error) => {
				this.ctx.logger?.error?.(error, `optional(${label}) 处理失败`)
			})
		}
			const logUnavailable = (ids: PluginIdentifier[], label: string) => {
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
			const attachWatcher = (
				ids: PluginIdentifier[],
				label: string,
				asMulti: boolean,
				keepGaps: boolean,
			) => {
				if (!handler || !watch) return
				let last = (keepGaps ? collectWithGaps(ids) : collectCompact(ids)) as Array<
					BasePlugin | undefined
				>
				this.ctx.on('afterCommit', (summary) => {
					const current = (keepGaps ? collectWithGaps(ids) : collectCompact(ids)) as Array<
						BasePlugin | undefined
					>
					if (!hasChanged(last, current)) return
					last = current
					if (!current.length || current.every((item) => item === undefined)) {
						logUnavailable(ids, label)
					}
					void invokeHandler(handler as any, current, summary, label, asMulti)
				})
			}

		if (!isPluginIdentifier(target)) {
			const importer = typeof target === 'function' ? target : () => target
			const label = importer.name || 'dynamic import'

			return this.optionalImport(importer, { onError: opts?.onError, label }).then((mod) => {
				if (mod === undefined) {
					return invokeHandler(handler as any, undefined, this._lastCommit, label, multi)
				}

				const ids = this.normalizePluginIdentifiers(mod)
				if (!ids.length) {
					const err = new Error(`optional(${label}) 未找到 BasePlugin 导出`)
					this.ctx.logger?.warn?.(err)
					opts?.onError?.(err)
					return Promise.resolve(
						invokeHandler(handler as any, undefined, this._lastCommit, label, multi),
					).then(() => (multi ? [] : undefined))
				}

				const payload = (
					multi ? collectWithGaps(ids) : collectCompact(ids)
				) as Array<BasePlugin | undefined>
				if (!payload.length || payload.every((item) => item === undefined)) {
					logUnavailable(ids, label)
				}
				if (handler) void invokeHandler(handler as any, payload, this._lastCommit, label, multi)
				attachWatcher(ids, label, multi, multi)
				return (multi ? payload : payload[0]) as any
			})
		}

		const ids = [target]
		const label = describe(ids)
		const payload = collectCompact(ids)
		if (!payload.length) logUnavailable(ids, label)
		void invokeHandler(handler as any, payload, this._lastCommit, label, false)
		attachWatcher(ids, label, false, false)
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

		const wrapped = this.wrapOptionalWithCaller(instance, callerCtx) as InstanceType<T>
		if (!map) {
			map = new Map()
			this.optionalViews.set(callerCtx, map)
		}
		map.set(ctor, { source: instance, view: wrapped })
		return wrapped
	}

	private normalizePluginIdentifiers(input: unknown): PluginIdentifier[] {
		if (typeof input === 'function' && input.prototype instanceof BasePlugin) {
			return [input as PluginIdentifier]
		}
		if (Array.isArray(input)) {
			return input.filter(
				(item): item is PluginIdentifier =>
					typeof item === 'function' && item.prototype instanceof BasePlugin,
			)
		}
		return []
	}


	public get lastCommit(): CommitSummary | undefined {
		return this._lastCommit
	}

	/* ------------------------------ Topo Utils ------------------------------ */

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
			for (let i = 0; i < deps.length; i++) {
				const dep = deps[i]!
				if (!inDegree.has(dep)) continue
				inDegree.set(id, inDegree.get(id)! + 1)
				graph.get(dep)!.push(id)
			}
		}

		const batches: PluginIdentifier[][] = []
		const zeroDegree: PluginIdentifier[] = []
		for (const [id, degree] of inDegree) if (degree === 0) zeroDegree.push(id)

		let frontier = zeroDegree
		while (frontier.length) {
			batches.push(frontier)
			const next: PluginIdentifier[] = []
			for (const current of frontier) {
				const dependents = graph.get(current)!
				for (let i = 0; i < dependents.length; i++) {
					const dependent = dependents[i]!
					const remaining = inDegree.get(dependent)! - 1
					inDegree.set(dependent, remaining)
					if (remaining === 0) next.push(dependent)
				}
			}
			frontier = next
		}

		const leftovers = new Set<PluginIdentifier>()
		for (const [id, degree] of inDegree) if (degree > 0) leftovers.add(id)

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
				const list = parents.get(child)!
				list.push(id)
			}
		}

		const order: PluginIdentifier[] = []
		const stack: PluginIdentifier[] = []
		for (const [id, count] of remainingChildren) if (count === 0) stack.push(id)

		while (stack.length) {
			const current = stack.pop()!
			order.push(current)
			const ancestors = parents.get(current)!
			for (let i = 0; i < ancestors.length; i++) {
				const parent = ancestors[i]!
				const next = (remainingChildren.get(parent) ?? 0) - 1
				remainingChildren.set(parent, next)
				if (next === 0) stack.push(parent)
			}
		}

		for (const [id, count] of remainingChildren) if (count > 0) order.push(id)
		return order
	}

	/* ------------------------------ Actor 管理 ------------------------------ */

	private ensureActor(id: PluginIdentifier, plugin: BasePlugin): PluginLifecycleRef {
		const key = id
		let ref = this.actors.get(key)

		// 若已有 actor 但已停止，丢弃并重建
		const snapshot = ref?.getSnapshot?.()
		const stopped = isStoppedSnapshot(snapshot)
		if (ref && stopped) {
			try {
				;(ref as any).stop?.()
			} catch {}
			this.actors.delete(key)
			ref = undefined as any
		}

		if (ref) return ref

		ref = this.lifecycleFactory({ id, runtime: BasePlugin.getLifecycleRuntime(plugin) })
		// 观察 actor 的错误事件，辅助诊断（不改变状态机逻辑）
		ref.subscribe({
			error: (err) =>
				this.ctx.logger?.error?.(err, `[actor:${String((id as any)?.name ?? id)}] unhandled error`),
		})

		ref.start()
		this.actors.set(key, ref)
		return ref
	}

	/** 启动：成功返回；失败抛出真实 init 错误（保留 cause）并保证清理 */
	private async startByActor(id: PluginIdentifier, plugin: BasePlugin): Promise<void> {
		const ref = this.ensureActor(id, plugin)
		const key = id
		const snapshotBeforeStart = ref.getSnapshot?.()
		if (isRunningSnapshot(snapshotBeforeStart)) return

		ref.send({ type: 'START' })

		let snapshot: LifecycleSnapshot
		try {
			snapshot = await ref.waitUntil(isStableSnapshot, this.startTimeoutMs)
		} catch (error) {
			await this.forceStop(ref)
			this.actors.delete(key)
			throw new Error(`Plugin ${id} start timeout after ${this.startTimeoutMs}ms`, {
				cause: error,
			})
		}

		if (isRunningSnapshot(snapshot)) return

		const latest = ref.getSnapshot?.()
		// 捕获失败原因（若有）
		const capturedErr: unknown =
			(latest as any)?.context?.err ??
			(snapshot as any)?.context?.err ??
			(snapshot as any)?.error ??
			undefined

		// 启动失败 → 主动 STOP（确保清理）
		await this.forceStop(ref)
		this.actors.delete(key)

		if (capturedErr instanceof Error) throw capturedErr
		if (capturedErr != null) throw new Error(String(capturedErr), { cause: capturedErr })

		throw new Error(`Plugin ${id} failed to start`)
	}

	private async forceStop(ref: PluginLifecycleRef): Promise<void> {
		try {
			ref.send({ type: 'STOP' })
		} catch {}
		await this.waitUntilStopped(ref)
	}

	private async waitUntilStopped(ref: PluginLifecycleRef): Promise<void> {
		const snapshot = ref.getSnapshot?.()
		if (isStoppedSnapshot(snapshot)) return
		try {
			await ref.waitUntil(isStoppedSnapshot, this.stopTimeoutMs)
		} catch {
			/* 忽略 */
		}
	}

	/** 停止：若 actor 存在，用它；否则冷启动一个只为 STOP 的 actor（也会 cleanup） */
	private async stopByActor(id: PluginIdentifier, pluginOrUndefined?: BasePlugin): Promise<void> {
		const key = id
		const existing = this.actors.get(key)
		if (existing) {
			const current = existing.getSnapshot?.()
			if (isStoppedSnapshot(current)) {
				this.actors.delete(key)
				return
			}
			await this.forceStop(existing)
			this.actors.delete(key)
			return
		}

		// 没有 actor：从容器或入参取实例，创建“冷 actor”仅用于清理
		const plugin = pluginOrUndefined ?? this.pluginRegistry?.lastContainer?.get(key)
		if (!plugin) return

		const ref = this.ensureActor(id, plugin)
		try {
			await this.forceStop(ref)
		} finally {
			this.actors.delete(key)
		}
	}

	/* --------------------------------- Commit -------------------------------- */

	private partitionChanges(changes: Array<{ type: string; key: unknown }>): {
		added: Set<PluginIdentifier>
		replaced: Set<PluginIdentifier>
		removed: Set<PluginIdentifier>
	} {
		const added = new Set<PluginIdentifier>()
		const replaced = new Set<PluginIdentifier>()
		const removed = new Set<PluginIdentifier>()

		for (const change of changes) {
			const id = change.key as PluginIdentifier
			switch (change.type) {
				case 'add':
					added.add(id)
					break
				case 'replace':
					replaced.add(id)
					break
				default:
					removed.add(id)
					break
			}
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
			if (instance) await this.stopByActor(id, instance)
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
			await this.startByActor(id, instance)
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
		const dependencies = plan.dependencies

		for (const batch of plan.batches) {
			const tasks: Promise<void>[] = []
			for (const id of batch) {
				if (failed.has(id)) continue

				const deps = dependencies.get(id) ?? []
				let blocked = false
				for (let i = 0; i < deps.length; i++) {
					if (failed.has(deps[i]!)) {
						blocked = true
						break
					}
				}
				if (blocked) {
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
	 * 非事务化提交（自管生命周期 FSM）：
	 * - 停机：对 remove/replace 逆拓扑停机（仅 send STOP + 等待 stopped）
	 * - 启动：对 add/replace 拓扑分批启动；失败只影响其依赖链，其它继续
	 * - 失败插件从 builder singletons 中清理（避免泄漏/误复用）
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
		const toStop = new Set<PluginIdentifier>([...removed, ...replaced])
		const toStart = new Set<PluginIdentifier>([...added, ...replaced])

		await this.applyTeardown(oldContainer, toStop)

		const toInitMap: ServiceMap<BasePlugin> = new Map()
		if (toStart.size) {
			for (const [serviceId, value] of container.services) {
				const id = serviceId as PluginIdentifier
				if (toStart.has(id)) toInitMap.set(id, value)
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

		return createOk({
			container: this.pluginRegistry.lastContainer,
			changes,
		})
	}
}
