import { type Context, Injectable } from '@pluxel/context'
import type { PluginIdentifier } from '../plugins'

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
	/**
	 * 当前作用域的清理回调集合。
	 *
	 * 设计/性能说明：
	 * - 每个插件 Context 都会拥有独立的 EffectScope（通过 PluginService.isolate）。
	 * - disposeAll() 会 “swap‑set” 来避免 Array.from 分配并保证：
	 *   1) 本轮清理只处理 disposeAll 调用前已注册的回调；
	 *   2) dispose 过程中新增的 effect 会进入新 Set，留给下次处理。
	 */
	public disposables: Set<() => void> = new Set()

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
		if (this.disposables.size === 0) return

		// swap‑set：零数组分配 + 保证新增 effect 不会被本轮误清理
		const current = this.disposables
		this.disposables = new Set()

		for (const fn of current) {
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
		// Use the runtime class as the unload target.
		// Canonicalization/aliases are handled by the DI container.
		this.unload(pluginInfo.class as PluginIdentifier)
	}

	/**
	 * 卸载指定插件（及其依赖链）
	 */
	unload(plugin: PluginIdentifier): void {
		this.ctx.registry.unregister(plugin)
		this.ctx.registry.commit()
	}
}
