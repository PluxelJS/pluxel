import { type Context, Injectable } from '@pluxel/context'
import type { PluginIdentifier } from '../plugin'

const serviceName = 'scope' as const
declare module '@pluxel/context' {
	interface Context {
		[serviceName]: EffectScopeService
		collectEffect: EffectScopeService['collectEffect']
		disposeAll: EffectScopeService['disposeAll']
		shutdown: EffectScopeService['shutdown']
	}
}

@Injectable({
	key: serviceName,
	methods: ['collectEffect', 'disposeAll', 'shutdown'] as const,
})
export class EffectScopeService {
	/** 私有存放所有注册的清理回调 */
	public disposables = new Set<() => void>()

	constructor(private ctx: Context) {}

	/**
	 * 注册一个清理函数到当前作用域，
	 * 返回一个可用于撤销注册的取消函数。
	 */
	collectEffect(fn: () => void): () => void {
		this.disposables.add(fn)
		return () => {
			this.disposables.delete(fn)
		}
	}

	/**
	 * 执行当前作用域下所有清理函数，
	 * 并清空注册列表。捕获并打印清理过程中的异常。
	 */
	disposeAll(): void {
		// 快照并清空，确保清理过程中不会误执行新增回调
		const toDispose = Array.from(this.disposables)
		this.disposables.clear()

		for (const fn of toDispose) {
			try {
				fn()
			} catch (error) {
				// 可根据项目日志方案替换下面一行
				console.error('[EffectScopeService] dispose error:', error)
			}
		}
	}

	/**
	 * 让当前插件主动关闭自己
	 * 适用于插件运行一段时间后需要正常退出的场景
	 */
	shutdown(): void {
		const pluginInfo = this.ctx.pluginInfo
		if (!pluginInfo) {
			throw new Error('Cannot shutdown: not in a plugin context')
		}
		const pluginClass = (pluginInfo.base ?? pluginInfo.class) as PluginIdentifier
		this.unload(pluginClass)
	}

	/**
	 * 卸载指定插件（及其依赖链）
	 */
	unload(plugin: PluginIdentifier): void {
		this.ctx.registry.pluginRegistry.unregisterPlugin(plugin)
		this.ctx.registry.commit()
	}
}
