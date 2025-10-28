// PluginService.ts

import type { Context, ServiceClass } from '@pluxel/context'
import { Injectable } from '@pluxel/context'
import { createErr, createOk, type Result } from 'option-t/plain_result'
// XState v5
import { createActor, waitFor } from 'xstate'
import type { ServiceMap } from '../container'
import { EffectScopeService } from '../service/EffectScopeService'
import { BasePlugin, PLUGIN_CTX } from './BasePlugin'
import { PluginContainer, type PluginDiContainer } from './PluginContainer'
import { createPluginLifecycle, type PluginLifecycleRef } from './pluginActor'
import { resolvePluginIdentifier, type StableInfo } from './PluginDecorator'
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

type LifecycleSnapshot = ReturnType<PluginLifecycleRef['getSnapshot']>

type InitPlan = {
	batches: PluginIdentifier[][]
	leftovers: Set<PluginIdentifier>
	dependencies: Map<PluginIdentifier, readonly PluginIdentifier[]>
}

const snapshotMatches = (snapshot: LifecycleSnapshot, state: string): boolean => {
	if (!snapshot) return false
	const matches = (snapshot as any)?.matches
	if (typeof matches === 'function') {
		try {
			return matches.call(snapshot, state)
		} catch {
			return false
		}
	}
	return false
}

const isStoppedSnapshot = (snapshot: LifecycleSnapshot): boolean =>
	!!snapshot && (snapshot.status === 'stopped' || snapshotMatches(snapshot, 'stopped'))

const isRunningSnapshot = (snapshot: LifecycleSnapshot): boolean =>
	!!snapshot && snapshotMatches(snapshot, 'running')

const isStableSnapshot = (snapshot: LifecycleSnapshot): boolean =>
	isRunningSnapshot(snapshot) || snapshotMatches(snapshot, 'failing') || isStoppedSnapshot(snapshot)

const serviceName = 'registry' as const
declare module '@pluxel/context' {
	namespace Context {
		interface Config {
			[serviceName]?: PluginServiceConfig
		}
	}
	export interface Context {
		[serviceName]: PluginService
		pluginInfo: StableInfo
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

	private readonly lifecycleMachine = createPluginLifecycle({
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
		const ref = this.actors.get(resolvePluginIdentifier(id))
		const snapshot = ref?.getSnapshot()
		if (snapshot === undefined) return false
		return isRunningSnapshot(snapshot)
	}

	public optional<T extends PluginIdentifier>(ctor: T) {
		const optionalDep = this.pluginRegistry.lastContainer?.getMaybe(resolvePluginIdentifier(ctor))
		return optionalDep
	}

	public afterCommit(listener: (summary: CommitSummary) => void | Promise<void>): void {
		this.ctx.on('afterCommit', listener)
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
		const key = resolvePluginIdentifier(id)
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

		ref = createActor(this.lifecycleMachine, {
			input: { id, runtime: BasePlugin.getLifecycleRuntime(plugin) },
		})
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
		const key = resolvePluginIdentifier(id)
		const snapshotBeforeStart = ref.getSnapshot?.()
		if (isRunningSnapshot(snapshotBeforeStart)) return

		ref.send({ type: 'START' })

		let snapshot: LifecycleSnapshot
		try {
			snapshot = await waitFor(ref, isStableSnapshot, {
				timeout: this.startTimeoutMs,
			})
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
			await waitFor(ref, isStoppedSnapshot, {
				timeout: this.stopTimeoutMs,
			})
		} catch {
			/* 忽略 */
		}
	}

	/** 停止：若 actor 存在，用它；否则冷启动一个只为 STOP 的 actor（也会 cleanup） */
	private async stopByActor(id: PluginIdentifier, pluginOrUndefined?: BasePlugin): Promise<void> {
		const key = resolvePluginIdentifier(id)
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
	 * 非事务化提交（纯 XState 托管）：
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
		return next as Promise<Result<unknown, unknown>>
	}

	private async executeCommit(): Promise<Result<unknown, unknown>> {
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
