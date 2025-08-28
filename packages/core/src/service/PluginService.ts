// PluginService.ts

import { randomUUID } from 'node:crypto'
import type { Context, ServiceClass } from '@pluxel/context'
import { Injectable } from '@pluxel/context'
import { createErr, createOk, type Result } from 'option-t/plain_result'
// XState v5
import { createActor, waitFor } from 'xstate'
import type { ServiceMap } from '../container'
import { getPluginInfo, type StableInfo } from '../pluginImpl'
import { type BasePlugin, PLUGIN_CTX } from '../pluginImpl/BasePlugin'
import { PluginContainer } from '../pluginImpl/PluginContainer'
import {
	createPluginLifecycle,
	lifecycleSelectors,
	type PluginLifecycleRef,
} from '../pluginImpl/pluginActor'
import type { PluginIdentifier, PluginInstance } from '../pluginImpl/types'
import { EffectScopeService } from './EffectScopeService'

type PluginServiceConfig = {
	plugigCTXIsolate?: ServiceClass<any>[]
	startTimeoutMs?: number
	stopTimeoutMs?: number
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
		pluginInfo: StableInfo
		parent?: Context
		caller?: Context
	}
}

@Injectable({ key: serviceName })
export class PluginService {
	// 容器：负责“构造实例 + 注入 ctx”；生命周期全由 XState 负责
	public pluginRegistry: PluginContainer = new PluginContainer()

	/** 每个插件一个生命周期 actor（唯一真相来源） */
	private readonly actors = new WeakMap<PluginIdentifier, PluginLifecycleRef<any, BasePlugin>>()

	/** 串行化 commit */
	private _commitLock: Promise<unknown> = Promise.resolve()

	/** 由容器在实例化时注入 ctx（每个插件隔离） */
	private createPluginCTX: () => Context

	/** 可调等待超时（毫秒） */
	private readonly startTimeoutMs
	private readonly stopTimeoutMs

	constructor(
		private ctx: Context,
		private config: PluginServiceConfig,
	) {
		this.startTimeoutMs = config?.startTimeoutMs ?? 1_500
		this.stopTimeoutMs = config?.stopTimeoutMs ?? 3_000

		const isolated = Array.from(new Set([...(config?.plugigCTXIsolate ?? []), EffectScopeService]))
		this.createPluginCTX = () => this.ctx.root.isolate(isolated, { name: `plugin:${randomUUID()}` })
	}

	/* ------------------------------ 状态查询 ------------------------------ */

	isRunning(id: PluginIdentifier): boolean {
		const ref = this.actors.get(id)
		return ref ? lifecycleSelectors.isRunning(ref.getSnapshot()) : false
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
		dependents: ReadonlyMap<PluginIdentifier, Set<PluginIdentifier>> | undefined,
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
				const set = parents.get(c)!
				set.add(id)
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

	private newLifecycle() {
		return createPluginLifecycle<any, BasePlugin>({
			autoStart: false,
			useErrorChannel: true,
		})
	}

	private ensureActor(
		id: PluginIdentifier,
		plugin: BasePlugin,
	): PluginLifecycleRef<any, BasePlugin> {
		let ref = this.actors.get(id)

		// 若已有 actor 但已停止，丢弃并重建
		const stopped = ref?.getSnapshot?.().status === 'stopped'
		if (ref && stopped) {
			try {
				;(ref as any).stop?.()
			} catch {}
			this.actors.delete(id)
			ref = undefined as any
		}

		if (ref) return ref

		const machine = this.newLifecycle()
		ref = createActor(machine, {
			input: { id, plugin, config: undefined },
		})
		// 观察 actor 的错误事件，辅助诊断（不改变状态机逻辑）
		ref.subscribe({
			error: (err) =>
				this.ctx.logger?.error?.(err, `[actor:${String((id as any)?.name ?? id)}] unhandled error`),
		})

		ref.start()
		this.actors.set(id, ref)
		return ref
	}

	/** 启动：成功返回；失败抛出真实 init/reload 错误（保留 cause）并保证清理 */
	private async startByActor(id: PluginIdentifier, plugin: BasePlugin): Promise<void> {
		const ref = this.ensureActor(id, plugin)
		ref.send({ type: 'START' })

		let snap: any
		try {
			// 等待首个“稳定”状态
			snap = await waitFor(
				ref,
				(s) => s.matches?.('failing') || s.matches?.('running') || s.matches?.('stopped'),
				{
					timeout: this.startTimeoutMs,
				},
			)
		} catch (e) {
			// 超时：主动 STOP 并清理，然后抛出超时错误
			try {
				ref.send({ type: 'STOP' })
			} catch {}
			try {
				await waitFor(ref, (s) => s.matches?.('stopped') || s.status === 'stopped', {
					timeout: this.stopTimeoutMs,
				})
			} catch {
				/* 忽略 */
			}
			this.actors.delete(id)
			throw new Error(`Plugin ${id} start timeout after ${this.startTimeoutMs}ms`, { cause: e })
		}

		if (snap.matches?.('running')) return

		// 捕获失败原因（若有）
		let capturedErr: unknown = snap?.context?.err
		if (capturedErr == null && snap.matches?.('stopped')) {
			const last = ref.getSnapshot?.()
			capturedErr = (last as any)?.context?.err ?? capturedErr
		}

		// 启动失败 → 主动 STOP（确保清理）
		try {
			ref.send({ type: 'STOP' })
		} catch {}
		try {
			await waitFor(ref, (s) => s.matches?.('stopped') || s.status === 'stopped', {
				timeout: this.stopTimeoutMs,
			})
		} catch {
			/* 忽略 */
		}
		this.actors.delete(id)

		// 原样抛出真实错误；若非 Error 也包装为 Error；最后才 fallback
		if (capturedErr instanceof Error) throw capturedErr
		if (capturedErr != null) throw new Error(String(capturedErr), { cause: capturedErr })

		throw new Error(`Plugin ${id} failed to start`)
	}

	/** 停止：若 actor 存在，用它；否则冷启动一个只为 STOP 的 actor（也会 cleanup） */
	private async stopByActor(id: PluginIdentifier, pluginOrUndefined?: BasePlugin): Promise<void> {
		const existing = this.actors.get(id)
		if (existing) {
			try {
				existing.send({ type: 'STOP' })
			} catch {}
			try {
				await waitFor(existing, (s) => s.matches?.('stopped') || s.status === 'stopped', {
					timeout: this.stopTimeoutMs,
				})
			} catch {
				/* 忽略 */
			}
			this.actors.delete(id)
			return
		}

		// 没有 actor：从容器或入参取实例，创建“冷 actor”仅用于清理
		const plugin = pluginOrUndefined ?? this.pluginRegistry?.lastContainer?.get(id)
		if (!plugin) return

		const ref = this.ensureActor(id, plugin)
		try {
			ref.send({ type: 'STOP' })
		} catch {}
		try {
			await waitFor(ref, (s) => s.matches?.('stopped') || s.status === 'stopped', {
				timeout: this.stopTimeoutMs,
			})
		} catch {
			/* 忽略 */
		}
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

				// —— changes 指 oldContainer 到 container 的变更，即注册表上插件的变更 —— //
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
					{
						remove: [...removeIds].map(String),
						replace: [...replaceIds].map(String),
						add: [...addIds].map(String),
					},
					'插件变更',
				)

				// remove 的插件：明确它不在新容器上，对旧容器进行停机
				const oldContainer = this.pluginRegistry.lastContainer
				const toStop = new Set<PluginIdentifier>([...removeIds, ...replaceIds])
				const toStart = new Set<PluginIdentifier>([...addIds, ...replaceIds])

				// —— 停机：逆拓扑（严格父后子前） —— //
				if (oldContainer && toStop.size) {
					const order = this.computeTeardownOrder(oldContainer.dependents, toStop)
					for (const id of order) {
						const inst = oldContainer.get(id)
						if (inst) await this.stopByActor(id, inst)
					}
				}

				// —— 启动：拓扑批次；失败仅影响下游 —— //
				const toInitMap: ServiceMap<BasePlugin> = new Map()
				// container.services 存有所有注册中插件的信息，筛出需要启动的
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
							// 若该插件的依赖在本轮失败，则该插件跳过并标记失败
							const deps = (toInitMap.get(id)?.dependencies ?? []) as PluginIdentifier[]
							if (deps.some((d) => failed.has(d))) {
								failed.add(id)
								return
							}

							// 从容器获取实例（此刻尚未注入生命周期）；注入隔离的 plugin ctx
							const r = container.getResult(id)
							if (r.err) {
								failed.add(id)
								this.ctx.logger.error(r.err, `解析 ${String(id)} 失败`)
								return
							}

							const instance: PluginInstance = r.val
							const pluginCtx = this.createPluginCTX()
							pluginCtx.pluginInfo = getPluginInfo(instance.constructor)
							instance[PLUGIN_CTX] = pluginCtx

							// getResult 期间若新建了单例，失败/停机时 disposeAll 会触发删除缓存，便于下次重试
							pluginCtx.scope.collectEffect(() => {
								this.pluginRegistry.singletons.delete(id)
							})

							try {
								await this.startByActor(id, instance)
							} catch (e) {
								pluginCtx.logger.error(e, `启动 ${String(id)} 失败`)
								// 保证清理
								try {
									await pluginCtx.scope.disposeAll()
								} catch {}
								failed.add(id)
							}
						}),
					)
				}

				// —— 切换容器 & 清理 builder 单例（避免泄漏） —— //
				action.val.confirm()
				if (failed.size) {
					// 删除未成功启动的实例，避免复用脏状态
					for (const id of failed) {
						this.pluginRegistry.singletons.delete(id)
					}
					this.ctx.logger.warn({ failed: [...failed].map(String) }, '以下插件启动失败')
					this.ctx.emit('commitFailed', failed)
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

		return this._commitLock as Promise<Result<unknown, unknown>>
	}
}
