import type { ExtendedDIContainer } from '@/container'
import type { Context } from '@pluxel/context'
import { Injectable } from '@pluxel/context'
import type { BasePlugin } from '../pluginImpl/BasePlugin'
import { PluginContainer } from '../pluginImpl/PluginContainer'
import {
	type Abstract,
	type PluginIdentifier,
	type ServiceMap,
	createErr,
	createOk,
} from '../pluginImpl/types'

declare module '@pluxel/context' {
	export interface Context {
		registry: PluginService
		parent?: Context
		caller?: Context
	}
}

@Injectable
export class PluginService {
	static key = 'registry'

	public pluginRegistry: PluginContainer

	constructor(private ctx: Context) {
		this.pluginRegistry = new PluginContainer(ctx)
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
			if (ch.type === 'remove') {
				removeIds.add(id)
			} else if (ch.type === 'replace') {
				replaceIds.add(id)
				addIds.add(id)
			} else {
				addIds.add(id)
			}
		}

		this.ctx.logger.info(removeIds, replaceIds, addIds)
		// —— 阶段一：卸载 remove + replace ——
		// 卸载插件必然用的是老容器
		const oldContainer = this.pluginRegistry.lastContainer
		for (const id of removeIds) {
			const p = oldContainer.get(id)
			p?.ctx.disposeAll()
		}
		for (const id of replaceIds) {
			const p = oldContainer.get(id)
			p?.ctx.disposeAll()
		}

		// —— 阶段二：按依赖拓扑分批初始化 replace + add ——
		// 先从 container.services 里挑出需要 init 的那一部分
		const toInitMap = new Map()
		for (const [key, val] of container.services) {
			if (!(addIds.has(key) || replaceIds.has(key))) {
				continue
			}
			toInitMap.set(key, val)
		}

		const batches = this.computeInitBatches(toInitMap, container)
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
		container: ExtendedDIContainer,
	): PluginIdentifier[][] {
		// —— 拓扑排序逻辑与上同 ——
		const inDegree = new Map<PluginIdentifier, number>()
		const dependentsMap = container.dependents
		console.log(dependentsMap)

		for (const id of plugins.keys()) {
			inDegree.set(id, 0)
		}
		for (const [id, { dependencies }] of plugins) {
			for (const dep of dependencies as PluginIdentifier[]) {
				inDegree.set(id, inDegree.get(id)! + 1)
			}
		}

		const batches: PluginIdentifier[][] = []
		let zeroQueue = Array.from(inDegree)
			.filter(([, d]) => d === 0)
			.map(([id]) => id)

		while (zeroQueue.length) {
			batches.push(zeroQueue)
			const next: PluginIdentifier[] = []
			for (const id of zeroQueue) {
				const dependents = dependentsMap.get(id)
				if (dependents === undefined) continue
				for (const dep of dependents) {
					const cnt = inDegree.get(dep)! - 1
					inDegree.set(dep, cnt)
					if (cnt === 0) next.push(dep)
				}
			}
			zeroQueue = next
		}

		return batches
	}
}
