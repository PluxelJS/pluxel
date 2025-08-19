// PluginService.ts
import type { Context, ServiceClass } from '@pluxel/context'
import { Injectable } from '@pluxel/context'
import type { ServiceMap } from '../container'
import { PLUGIN_CTX, type BasePlugin } from '../pluginImpl/BasePlugin'
import { PluginContainer } from '../pluginImpl/PluginContainer'
import type { PluginIdentifier, PluginInstance } from '../pluginImpl/types'
import { type Result, createErr, createOk } from 'option-t/plain_result'

import { randomUUID } from 'node:crypto'
import { EffectScopeService } from './EffectScopeService'
import type { PluginMetadata } from '../pluginImpl'

// XState v5
import { createActor, waitFor } from 'xstate'
import {
	createPluginLifecycle,
	type PluginLifecycleRef,
} from '../pluginImpl/pluginActor'

@Injectable({ key: 'registry' })
export class PluginService {
	public pluginRegistry: PluginContainer

	/** 每个插件一个生命周期 actor（唯一真相来源） */
	private readonly actors = new WeakMap<
		PluginIdentifier,
		PluginLifecycleRef<any, BasePlugin>
	>()

	/** 串行化 commit */
	private _commitLock: Promise<unknown> = Promise.resolve()

	/** 由容器在实例化时注入 ctx（每个插件隔离） */
	private createPluginCTX: () => Context

	/** 可调等待超时（毫秒） */
	private readonly startTimeoutMs = 30_000
	private readonly stopTimeoutMs = 15_000

	constructor(
		private ctx: Context,
		private config: { plugigCTXIsolate?: ServiceClass<any>[] },
	) {
		const isolated = Array.from(
			new Set([...(config?.plugigCTXIsolate ?? []), EffectScopeService]),
		)
		this.createPluginCTX = () =>
			this.ctx.root.isolate(isolated, { name: `plugin:${randomUUID()}` })

		// 容器：负责“构造实例 + 注入 ctx”；生命周期全由 XState 负责
		this.pluginRegistry = new PluginContainer(this.createPluginCTX)
	}

	/* ------------------------------ 状态查询 ------------------------------ */

	isRunning(id: PluginIdentifier): boolean {
		const ref = this.actors.get(id)
		return ref
			? ((ref.getSnapshot() as any).matches?.('running') ?? false)
			: false
	}

	/* ------------------------------ Topo Utils ------------------------------ */

	private computeInitBatchesStrict(plugins: ServiceMap<BasePlugin>): {
		batches: PluginIdentifier[][]
		leftovers: Set<PluginIdentifier>
	} {
		const inDegree = new Map<PluginIdentifier, number>()
		const graph = new Map<PluginIdentifier, PluginIdentifier[]>()

		for (const id of plugins.keys()) {
			inDegree.set(id, 0)
			graph.set(id, [])
		}
		for (const [id, plugin] of plugins) {
			const deps = plugin.dependencies as PluginIdentifier[]
			for (let i = 0; i < deps.length; i++) {
				const d = deps[i]!
				if (!inDegree.has(d)) continue
				inDegree.set(id, inDegree.get(id)! + 1)
				graph.get(d)!.push(id)
			}
		}

		const batches: PluginIdentifier[][] = []
		let zero = Array.from(inDegree.entries())
			.filter(([, k]) => k === 0)
			.map(([id]) => id)

		while (zero.length) {
			batches.push(zero)
			const next: PluginIdentifier[] = []
			for (const u of zero)
				for (const v of graph.get(u)!) {
					const k = inDegree.get(v)! - 1
					inDegree.set(v, k)
					if (k === 0) next.push(v)
				}
			zero = next
		}

		const leftovers = new Set<PluginIdentifier>()
		for (const [id, k] of inDegree) if (k > 0) leftovers.add(id)
		return { batches, leftovers }
	}

	private computeTeardownOrder(
		dependents:
			| ReadonlyMap<PluginIdentifier, Set<PluginIdentifier>>
			| undefined,
		affected: Set<PluginIdentifier>,
	): PluginIdentifier[] {
		if (!dependents || affected.size === 0) return []
		// node -> parents（被其依赖者）
		const indeg = new Map<PluginIdentifier, number>()
		const parents = new Map<PluginIdentifier, Set<PluginIdentifier>>()
		for (const id of affected) {
			indeg.set(id, 0)
			parents.set(id, new Set())
		}
		for (const id of affected) {
			const ch = dependents.get(id) ?? new Set()
			for (const c of ch) {
				if (!affected.has(c)) continue
				indeg.set(id, (indeg.get(id) ?? 0) + 1)
				parents.get(c)!.add(id)
			}
		}

		const order: PluginIdentifier[] = []
		const q: PluginIdentifier[] = []
		for (const [id, d] of indeg) if (d === 0) q.push(id)
		while (q.length) {
			const x = q.pop()!
			order.push(x)
			for (const p of parents.get(x)!) {
				const d = (indeg.get(p) ?? 0) - 1
				indeg.set(p, d)
				if (d === 0) q.push(p)
			}
		}
		for (const [id, d] of indeg) if (d > 0) order.push(id)
		return order
	}

	/* ------------------------------ Actor 管理 ------------------------------ */

	private ensureActor(
		id: PluginIdentifier,
		plugin: BasePlugin,
		pluginCtx: Context,
	): PluginLifecycleRef<any, BasePlugin> {
		let ref = this.actors.get(id)
		if (ref) return ref

		const machine = createPluginLifecycle<any, BasePlugin>({ autoStart: false })
		ref = createActor(machine, {
			input: { id, plugin, pluginCtx, config: undefined },
		})
		ref.start()
		this.actors.set(id, ref)
		return ref
	}

	private async startByActor(
		id: PluginIdentifier,
		plugin: BasePlugin,
	): Promise<void> {
		const ref = this.ensureActor(id, plugin, plugin.ctx)
		ref.send({ type: 'START' })

		const snap = await waitFor(
			ref,
			(s) =>
				s.matches?.('running') ||
				s.matches?.('failing') ||
				s.matches?.('stopped'),
			{ timeout: this.startTimeoutMs },
		)

		if (snap.matches?.('running')) return

		// 启动失败：触发 STOP 让状态机负责清理，然后抛错以便裁剪
		ref.send({ type: 'STOP' })
		await waitFor(
			ref,
			(s) => s.matches?.('stopped') || s.status === 'stopped',
			{
				timeout: this.stopTimeoutMs,
			},
		)
		this.actors.delete(id)
		const err = (snap as any).context?.err
		throw err ?? new Error(`Plugin ${String(id)} failed to start`)
	}

	private async stopByActor(
		id: PluginIdentifier,
		pluginOrUndefined?: BasePlugin,
	) {
		// 统一用 XState；若没有 actor，也创建一个“冷 actor”，直接 STOP -> stopped（会 cleanupCtx）
		const plugin =
			pluginOrUndefined ?? this.pluginRegistry.lastContainer?.get(id)
		if (!plugin) return
		const ref = this.ensureActor(id, plugin, plugin[PLUGIN_CTX])
		ref.send({ type: 'STOP' })
		await waitFor(
			ref,
			(s) => s.matches?.('stopped') || s.status === 'stopped',
			{
				timeout: this.stopTimeoutMs,
			},
		)
		this.actors.delete(id)
	}

	/* --------------------------------- Commit -------------------------------- */

	/**
	 * 非事务化提交（纯 XState 托管）：
	 * - 停机：对 remove/replace 逆拓扑停机（仅 send STOP + 等待 stopped）
	 * - 启动：对 add/replace 拓扑分批启动；失败只影响其依赖链，其它继续
	 * - 失败插件从 builder singletons 中清理（避免泄漏/误复用）
	 */
	async commit() {
		this._commitLock = this._commitLock
			.then(async () => {
				const action = this.pluginRegistry.build()
				if (!action.ok) {
					action.err.ret.undo()
					this.ctx.logger.error(action.err.err, '插件在依赖项解析时失败')
					return createErr(action.err.err)
				}

				const { changes, container } = action.val
				if (changes.length === 0) return createOk({ container, changes })

				// —— changes 指 oldContainer 到 container 的变更，即注册表上插件的变更。  —— //
				const removeIds = new Set<PluginIdentifier>()
				const replaceIds = new Set<PluginIdentifier>()
				const addIds = new Set<PluginIdentifier>()
				for (const ch of changes) {
					const id = ch.key as PluginIdentifier
					if (ch.type === 'add') addIds.add(id)
					else if (ch.type === 'replace') replaceIds.add(id)
					else removeIds.add(id)
				}
				this.ctx.logger.info(
					removeIds,
					'移除',
					replaceIds,
					'替换',
					addIds,
					'添加',
				)

				// 如果是 remove 的插件明确它必然不会在新容器上，操作对旧容器进行。
				const oldContainer = this.pluginRegistry.lastContainer
				const toStop = new Set<PluginIdentifier>([...removeIds, ...replaceIds])
				const toStart = new Set<PluginIdentifier>([...addIds, ...replaceIds])

				// —— 停机：逆拓扑（严格父后子前） —— //
				if (oldContainer && toStop.size) {
					const order = this.computeTeardownOrder(
						oldContainer.dependents,
						toStop,
					)
					for (const id of order) {
						const inst = oldContainer.get(id)
						if (inst) await this.stopByActor(id, inst)
					}
				}

				// —— 启动：拓扑批次；失败仅影响下游 —— //
				const toInitMap: ServiceMap<BasePlugin> = new Map()
				// container.services 存有所有注册中插件的信息，其中不乏已经正在运行，从中筛选出需要启动的
				for (const [k, v] of container.services) {
					const id: PluginIdentifier = k
					if (toStart.has(id)) toInitMap.set(id, v)
				}
				const { batches, leftovers } = this.computeInitBatchesStrict(toInitMap)

				// 启动失败的插件，不影响下游插件的启动
				const failed = new Set<PluginIdentifier>(leftovers)

				for (const batch of batches) {
					await Promise.all(
						batch.map(async (id) => {
							// 如果该插件的上级依赖在本次启动有错误的，插件本身也为 failed
							const deps = (toInitMap.get(id)?.dependencies ??
								[]) as PluginIdentifier[]
							if (deps.some((d) => failed.has(d))) {
								failed.add(id)
								return
							}

							// 本阶段从插件注册表获取实例，get 本质是通过插件构造函数创建新实例的手段，实际上还没注入生命周期。
							// 本阶段完成插件的实例获取和 CTX 注入(包括CTX回收实例本身)
							const r = container.getResult(id)
							if (r.err) {
								failed.add(id)
								this.ctx.logger.error(r.err, `解析 ${String(id)} 失败`)
								return
							}
							const instance: PluginInstance = r.val
							const pluginCtx = this.createPluginCTX()
							instance[PLUGIN_CTX] = pluginCtx
							// 当我们成功 getResult 的时候，singletons 已经存在实例，失败/停机时 disposeAll 会触发删除缓存，便于下次重试
							pluginCtx.scope.collectEffect(() => {
								this.pluginRegistry.singletons.delete(id)
							})

							// 本阶段开始生命周期
							try {
								await this.startByActor(id, instance)
							} catch (e) {
								pluginCtx.scope.disposeAll()
								this.ctx.logger.error(e, `启动 ${String(id)} 失败`)
								failed.add(id)
							}
						}),
					)
				}

				// —— 切换容器 & 清理 builder 单例（避免泄漏） —— //
				action.val.confirm()
				if (failed.size) {
					// 这里删除的是 container.get 产生的实例，实际没启动成功的删掉下次 get 还是会新建，相当于刷新状态。
					for (const id of failed) {
						this.pluginRegistry.singletons.delete(id)
					}
					this.ctx.logger.warn(failed, '以下插件启动失败:')
				}

				return createOk({
					container: this.pluginRegistry.lastContainer,
					changes,
				})
			})
			.catch((e) => {
				this.ctx.logger.error(e, 'commit 内部异常')
				return createErr(e)
			})

		return this._commitLock
	}
}
