// PluginService.ts
import type { Context, ServiceClass } from '@pluxel/context'
import { Injectable } from '@pluxel/context'
import type { ServiceMap } from '../container'
import type { BasePlugin } from '../pluginImpl/BasePlugin'
import { PluginContainer } from '../pluginImpl/PluginContainer'
import type { PluginIdentifier } from '../pluginImpl/types'
import { type Result, createErr, createOk } from 'option-t/plain_result'

interface PluginServiceConfig {
	plugigCTXIsolate?: ServiceClass<any>[]
}

declare module '@pluxel/context' {
	namespace Context {
		interface Config {
			registry?: PluginServiceConfig
		}
	}
	export interface Context {
		registry: PluginService
		pluginMeta: PluginMetadata
		parent?: Context
		caller?: Context
	}
}

import { randomUUID } from 'node:crypto'
import { EffectScopeService } from './EffectScopeService'
import type { PluginMetadata } from '../pluginImpl'

/** 轻量运行态 */
enum PluginState {
	Registered = 'registered',
	Running = 'running',
	Stopped = 'stopped',
}

@Injectable
export class PluginService {
	static key = 'registry'

	public pluginRegistry: PluginContainer
	private readonly state = new Map<PluginIdentifier, PluginState>()
	private _commitLock: Promise<unknown> = Promise.resolve()

	constructor(
		private ctx: Context,
		private config: PluginServiceConfig,
	) {
		// 去重隔离 + 附加 EffectScopeService
		const isolated = Array.from(
			new Set([...(config?.plugigCTXIsolate ?? []), EffectScopeService]),
		)
		this.pluginRegistry = new PluginContainer(() => {
			return this.ctx.root.isolate(isolated, {
				name: `plugin:${randomUUID()}`,
			})
		})
	}

	getPluginRunning(pluginId: PluginIdentifier) {
		return this.state.get(pluginId) === PluginState.Running
	}

	/* ------------------------------ Topo Helpers ------------------------------ */

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
			.filter(([, deg]) => deg === 0)
			.map(([id]) => id)

		while (zero.length) {
			batches.push(zero)
			const next: PluginIdentifier[] = []
			for (const u of zero) {
				for (const v of graph.get(u)!) {
					const k = inDegree.get(v)! - 1
					inDegree.set(v, k)
					if (k === 0) next.push(v)
				}
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

	/* --------------------------------- Commit -------------------------------- */

	/**
	 * 非事务化提交：
	 * - 停机：对 remove/replace 逆拓扑停机（先子后父）
	 * - 启动：对 add/replace 拓扑分批启动；失败只影响其依赖链，其它继续
	 * - 失败插件将被**从最终容器裁剪掉**（不可检索）
	 */
	async commit() {
		this._commitLock = this._commitLock
			.then(async () => {
				const action = this.pluginRegistry.build()
				if (!action.ok) {
					action.err.ret.undo()
					this.ctx.logger.error('插件在依赖项解析时失败', action.err.err)
					return createErr(action.err.err)
				}

				const { changes, container } = action.val
				if (changes.length === 0) return createOk({ container, changes })

				// —— 变更分类 —— //
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
					'移除',
					removeIds,
					'替换',
					replaceIds,
					'添加',
					addIds,
				)

				const old = this.pluginRegistry.lastContainer
				const toStop = new Set<PluginIdentifier>([...removeIds, ...replaceIds])
				const toStart = new Set<PluginIdentifier>([...addIds, ...replaceIds])

				// —— 停机：逆拓扑 —— //
				if (old && toStop.size) {
					const order = this.computeTeardownOrder(old.dependents as any, toStop)
					for (const id of order) {
						const inst = old.get(id) as BasePlugin | undefined
						if (!inst) continue
						try {
							await inst.stop?.()
						} catch (e) {
							this.ctx.logger.warn(`stop ${String(id)} 异常`, e)
						}
						try {
							inst.ctx.disposeAll()
						} catch (e) {
							this.ctx.logger.warn(`dispose ${String(id)} 异常`, e)
						}
						this.state.set(id, PluginState.Stopped)
					}
				}

				// —— 启动：拓扑批次；失败仅影响下游 —— //
				const toInitMap = new Map<PluginIdentifier, any>()
				for (const [k, v] of container.services) {
					const id = k as PluginIdentifier
					if (toStart.has(id)) toInitMap.set(id, v)
				}
				const { batches, leftovers } = this.computeInitBatchesStrict(
					toInitMap as unknown as ServiceMap<BasePlugin>,
				)

				const failed = new Set<PluginIdentifier>()
				// leftovers（通常构建期已拦截），这里保守处理为失败
				for (const id of leftovers) failed.add(id)

				for (const batch of batches) {
					await Promise.all(
						batch.map(async (id) => {
							// 依赖失败 → 跳过并标记失败
							const deps = (toInitMap.get(id)?.dependencies ??
								[]) as PluginIdentifier[]
							if (deps.some((d) => failed.has(d))) {
								failed.add(id)
								return
							}

							const r = container.getResult(id as any)
							if (r.err) {
								failed.add(id)
								this.ctx.logger.error(`解析 ${String(id)} 失败`, r.err)
								return
							}

							const inst = r.val as BasePlugin
							try {
								if (typeof inst.init === 'function') {
									await inst.init()
								}
								this.state.set(id, PluginState.Running)
							} catch (e) {
								this.ctx.logger.error(`启动 ${String(id)} 失败`, e)
								try {
									inst.ctx.disposeAll()
								} catch {}
								this.state.set(id, PluginState.Stopped)
								failed.add(id)
							}
						}),
					)
				}

				// —— 切换容器，并把失败插件**从容器中裁剪掉** —— //
				action.val.confirm()

				if (failed.size) {
					// 从 builder_singletons 中清理失败插件（避免泄漏/后续误复用）
					for (const id of failed) {
						this.pluginRegistry.singletons.delete(id as any)
					}
					// 使用裁剪版容器覆盖
					const pruned = this.pluginRegistry.finalizeWithFilter(
						this.pluginRegistry.lastContainer,
						failed,
					)
					this.pluginRegistry.lastContainer = pruned
					this.ctx.logger.warn('以下插件启动失败（已从容器移除）:', [...failed])
				}

				return createOk({
					container: this.pluginRegistry.lastContainer,
					changes,
				})
			})
			.catch((e) => {
				this.ctx.logger.error('commit 内部异常', e)
				return createErr(e)
			})

		return this._commitLock
	}
}
