// RpcService.ts - RPC 扩展管理服务
import { type Context } from '@pluxel/core'
import type { RpcTarget } from 'capnweb'
import type { UI } from './ui'

/** 扩展工厂：每次 RPC 请求时调用，返回 RpcTarget 实例 */
export type RpcExtensionFactory<T extends RpcTarget = RpcTarget> = (ctx: Context) => T

export class RpcService {
	// 扩展一般不会很多，<128 完全可以不用 Map
	private extensions: Record<string, RpcExtensionFactory | null> = Object.create(null)
	private deadKeys = 0
	private static readonly COMPACT_THRESHOLD = 16

	constructor(public ctx: Context, _cfg: unknown = undefined) {}

	/**
	 * 注册 RPC 扩展（使用当前插件名作为命名空间）
	 * @param factory 工厂函数，每次 RPC 请求时调用
	 * @returns 清理函数（自动与 scope 集成）
	 */
	registerExtension<T extends RpcTarget>(factory: RpcExtensionFactory<T>): () => void {
		const namespace = this.ctx.pluginInfo.id
		if (namespace in this.extensions && this.extensions[namespace] !== null) {
			this.ctx.logger.warn('Extension "{namespace}" already registered, overwriting', { namespace })
		}

		this.extensions[namespace] = factory

		const guard = this.ctx.effects.defer(() => {
			if (this.extensions[namespace] === factory) {
				this.extensions[namespace] = null
				this.deadKeys++
				this.maybeCompact()
			}
		})
		return () => guard.dispose()
	}

	/** 懒清理：达到阈值时重建对象 */
	private maybeCompact() {
		if (this.deadKeys < RpcService.COMPACT_THRESHOLD) return
		const fresh: Record<string, RpcExtensionFactory> = Object.create(null)
		for (const key in this.extensions) {
			const val = this.extensions[key]
			if (val !== null) fresh[key] = val
		}
		this.extensions = fresh
		this.deadKeys = 0
	}

	/**
	 * 创建扩展视图（供 HmrRpcApi 使用）
	 * 使用 Object.defineProperty 定义 getter，避免 Proxy
	 */
	createExtensionsView(ctx: Context): UI.rpc {
		// 需要使用普通对象（带 Object.prototype）以便 RPC 层能够序列化
		const view = {} as UI.rpc
		for (const name in this.extensions) {
			const factory = this.extensions[name]
			if (factory === null) continue
			Object.defineProperty(view, name, {
				get: () => factory(ctx),
				enumerable: true,
				configurable: true,
			})
		}
		return view
	}

	/**
	 * 获取所有已注册的命名空间
	 */
	getNamespaces(): string[] {
		const result: string[] = []
		for (const key in this.extensions) {
			if (this.extensions[key] !== null) result.push(key)
		}
		return result
	}

	/**
	 * 检查命名空间是否已注册
	 */
	hasExtension(namespace: string): boolean {
		return namespace in this.extensions && this.extensions[namespace] !== null
	}
}
