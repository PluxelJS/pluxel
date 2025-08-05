import type { Context, ServiceClass } from '@pluxel/context'
import { Injectable } from '@pluxel/context'
import type { ServiceMap } from '../container'
import type { BasePlugin } from '../pluginImpl/BasePlugin'
import { PluginContainer } from '../pluginImpl/PluginContainer'
import { type PluginIdentifier, createErr, createOk } from '../pluginImpl/types'

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

@Injectable
export class PluginService {
	static key = 'registry'

	public pluginRegistry: PluginContainer

	constructor(
		private ctx: Context,
		private config: PluginServiceConfig,
	) {
		const isolated = config?.plugigCTXIsolate ?? [EffectScopeService]
		isolated?.push(EffectScopeService)
		this.pluginRegistry = new PluginContainer(() => {
			return this.ctx.root.isolate(isolated, {
				name: `meta.name_${randomUUID()}`,
			})
		})
	}

	getPluginRunning(pluginId: PluginIdentifier) {
		const container = this.pluginRegistry.lastContainer
		if (container === undefined) return false
		const plugin = container.services.get(pluginId)
		return plugin !== undefined
	}

	async commit() {
		const action = this.pluginRegistry.build()
		if (!action.ok) {
			action.err.ret.undo()
			this.ctx.logger.error('插件在依赖项解析时失败', action.err.err)
			return createErr(action.err.err)
		}

		const { changes, container } = action.val
		if (changes.length === 0) return createOk({ container, changes })

		// —— 一次遍历完成分类 ——
		const removeIds = new Set<PluginIdentifier>()
		const replaceIds = new Set<PluginIdentifier>()
		const addIds = new Set<PluginIdentifier>()

		for (const ch of changes) {
			const id = ch.key as PluginIdentifier
			if (ch.type === 'add') {
				addIds.add(id)
			} else if (ch.type === 'replace') {
				replaceIds.add(id)
			} else {
				removeIds.add(id)
			}
		}

		this.ctx.logger.info('移除', removeIds, '替换', replaceIds, '添加', addIds)
		// —— 阶段一：卸载 remove + replace ——
		// 卸载插件必然用的是老容器
		const oldContainer = this.pluginRegistry.lastContainer
		for (const id of removeIds) {
			const p = oldContainer.get(id)
			console.log(p.ctx.scope.disposables)
			p.ctx.disposeAll()
		}
		for (const id of replaceIds) {
			const p = oldContainer.get(id)
			p.ctx.disposeAll()
		}

		// —— 阶段二：按依赖拓扑分批初始化 replace + add ——
		// 先从 container.services 里挑出需要 init 的那一部分
		const toInitMap = new Map()
		for (const [key, val] of container.services) {
			const shouldInit = addIds.has(key) || replaceIds.has(key)
			if (!shouldInit) {
				continue
			}
			toInitMap.set(key, val)
		}

		const batches = this.computeInitBatches(toInitMap)
		const failed = new Set<PluginIdentifier>()
		const succeeded = new Set<PluginIdentifier>()

		for (const batch of batches) {
			await Promise.all(
				batch.map(async (id) => {
					// 跳过有失败依赖的插件
					const deps = toInitMap.get(id)!.dependencies as PluginIdentifier[]
					if (deps.some((d) => failed.has(d))) {
						failed.add(id)
						return
					}

					const p = container.get(id)!
					try {
						await p.init()
						succeeded.add(id)
					} catch (err) {
						this.ctx.logger.error(`初始化 ${id} 失败：`, err)
						p.ctx.disposeAll()
						failed.add(id)
					}
				}),
			)
		}

		// 确认操作以用现 container 覆盖 oldContainer
		action.val.confirm()
		return createOk({ container, changes })
	}

	public computeInitBatches(
		plugins: ServiceMap<BasePlugin>,
	): PluginIdentifier[][] {
		// 1. 构建子图：初始化 inDegree 和 依赖反向表 graph
		const inDegree = new Map<PluginIdentifier, number>()
		const graph = new Map<PluginIdentifier, PluginIdentifier[]>()

		// 先把所有待初始化插件的节点放进去
		for (const id of plugins.keys()) {
			inDegree.set(id, 0)
			graph.set(id, [])
		}

		// 遍历每个插件的 dependencies，只统计那些也在 plugins 里的依赖
		for (const [id, plugin] of plugins) {
			for (const dep of plugin.dependencies as PluginIdentifier[]) {
				if (!inDegree.has(dep)) continue // 忽略非本次子集依赖
				inDegree.set(id, inDegree.get(id)! + 1)
				graph.get(dep)!.push(id) // dep → id
			}
		}

		// 2. 逐轮出队：一次把当前所有入度为 0 的节点组成一个 batch
		const batches: PluginIdentifier[][] = []
		let zeroBatch = Array.from(inDegree.entries())
			.filter(([, deg]) => deg === 0)
			.map(([id]) => id)

		while (zeroBatch.length) {
			batches.push(zeroBatch)
			const nextBatch: PluginIdentifier[] = []

			for (const id of zeroBatch) {
				for (const dep of graph.get(id)!) {
					const cnt = inDegree.get(dep)! - 1
					inDegree.set(dep, cnt)
					if (cnt === 0) nextBatch.push(dep)
				}
			}

			zeroBatch = nextBatch
		}

		return batches
	}
}
