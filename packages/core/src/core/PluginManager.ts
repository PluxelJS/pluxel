// PluginManager.ts
import {
	type Abstract,
	ExtendedContainerBuilder,
	type ExtendedDIContainer,
	type Newable,
	type ServiceMap,
} from '@/container'
import type { BasePlugin } from './BasePlugin'
import type { GlobalContext } from './GlobalContext'
import { PluginContainer } from './PluginContainer'
import type { PluginClass, PluginIdentifier } from './types'

export class PluginManager {
	public pluginRegistry: PluginContainer
	private diContainer!: ExtendedDIContainer

	constructor(private globalCtx: GlobalContext) {
		// 让容器内部能访问插件管理器单例
		this.pluginRegistry = new PluginContainer(globalCtx)
	}

	// 无论如何都确保返回容器，此处出错只和声明依赖未注册有关，和实例化无关。
	private commitContainer(): ExtendedDIContainer {
		const result = this.pluginRegistry.commit()

		if (!result.ok) {
			for (const err of result.err) {
				for (const p of err.chain) {
					this.pluginRegistry.unregisterPlugin(p as PluginClass)
					this.globalCtx.logger.error(err.message)
				}
			}
			return this.commitContainer()
		}

		return result.val
	}

	public computeInitBatches(
		plugins: ServiceMap<BasePlugin>,
	): PluginIdentifier[][] {
		const inDegree = new Map<PluginIdentifier, number>()
		const dependents = new Map<PluginIdentifier, Set<PluginIdentifier>>()

		for (const id of plugins.keys()) {
			inDegree.set(id, 0)
			dependents.set(id, new Set())
		}

		for (const [id, data] of plugins) {
			for (const dep of data.dependencies) {
				if (!plugins.has(dep as Abstract<BasePlugin>)) {
					throw new Error(`Missing dependency “${dep}” for plugin “${id}”`)
				}
				// biome-ignore lint/style/noNonNullAssertion: <explanation>
				inDegree.set(id, inDegree.get(id)! + 1)
				// biome-ignore lint/style/noNonNullAssertion: <explanation>
				dependents.get(dep as Abstract<BasePlugin>)!.add(id)
			}
		}

		const batches: PluginIdentifier[][] = []
		let zeroQueue = Array.from(inDegree.entries())
			.filter(([, d]) => d === 0)
			.map(([id]) => id)

		while (zeroQueue.length) {
			batches.push(zeroQueue)
			const next: PluginIdentifier[] = []
			for (const id of zeroQueue) {
				// biome-ignore lint/style/noNonNullAssertion: <explanation>
				for (const dep of dependents.get(id)!) {
					// biome-ignore lint/style/noNonNullAssertion: <explanation>
					const nd = inDegree.get(dep)! - 1
					inDegree.set(dep, nd)
					if (nd === 0) next.push(dep)
				}
			}
			zeroQueue = next
		}

		if (Array.from(inDegree.values()).some((d) => d > 0)) {
			throw new Error('Circular dependency detected')
		}
		return batches
	}

	/**
	 * 构建 DI 容器，解析各插件实例，但不调用 init()。
	 * 返回构建结果，包括：
	 * - container：DI 容器
	 * - succeeded：能够实例化的插件标识列表
	 * - failed：实例化失败的插件标识列表
	 */
	public async commitWithStatus(): Promise<{
		container: ExtendedDIContainer
		succeeded: Set<PluginIdentifier>
		failed: Set<PluginIdentifier>
	}> {
		const container = this.commitContainer()
		const plugins = container.getServices() as ServiceMap<BasePlugin>

		const batches = this.computeInitBatches(plugins)
		const succeeded = new Set<PluginIdentifier>()
		const failed = new Set<PluginIdentifier>()

		for (const batch of batches) {
			// 并行尝试初始化本批次
			await Promise.all(
				batch.map(async (id) => {
					// 如果有任何依赖失败，直接跳过
					if (plugins.get(id)?.dependencies.some((dep) => failed.has(dep))) {
						failed.add(id)
						return
					}

					try {
						// 此处实例化
						const p: BasePlugin = container.get(id)
						await p?.init()
						succeeded.add(id)
					} catch (err) {
						console.error(`Init failed for ${id}:`, err)
						failed.add(id)
					}
				}),
			)
		}

		return { container, succeeded, failed }
	}
}

enum PluginErrorType {
	CONSTRUCTOR = 'CONSTRUCTOR_ERROR',
	DEPENDENCY = 'DEPENDENCY_ERROR',
}

interface PluginError {
	type: PluginErrorType
	message: string
	cause?: any
}
