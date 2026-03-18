// RpcService.ts - RPC 扩展管理服务
import { type Context } from '@pluxel/core'
import type { RpcTarget } from 'capnweb'
import type { HmrUiRpcMap } from '../../web/protocol'

/** 扩展工厂：每次 RPC 请求时调用，返回 RpcTarget 实例 */
export type RpcExtensionFactory<T extends RpcTarget = RpcTarget> = (ctx: Context) => T

export class RpcService {
	private readonly extensions = new Map<string, RpcExtensionFactory>()

	constructor(
		public ctx: Context,
		_cfg: unknown = undefined,
	) {}

	/**
	 * 注册 RPC 扩展（使用当前插件名作为命名空间）
	 * @param factory 工厂函数，每次 RPC 请求时调用
	 * @returns 清理函数（自动与 scope 集成）
	 */
	registerExtension<T extends RpcTarget>(factory: RpcExtensionFactory<T>): () => void {
		const namespace = this.ctx.pluginInfo.id
		if (this.extensions.has(namespace)) {
			this.ctx.logger.warn('Extension "{namespace}" already registered, overwriting', { namespace })
		}

		this.extensions.set(namespace, factory)

		const guard = this.ctx.effects.defer(() => {
			if (this.extensions.get(namespace) === factory) this.extensions.delete(namespace)
		})
		return () => guard.dispose()
	}

	/**
	 * 创建扩展视图（供 HmrRpcApi 使用）
	 * 使用 Object.defineProperty 定义 getter，避免 Proxy
	 */
	createExtensionsView(ctx: Context): HmrUiRpcMap {
		// 需要使用普通对象（带 Object.prototype）以便 RPC 层能够序列化
		const view = {} as HmrUiRpcMap
		for (const [name, factory] of this.extensions) {
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
		return Array.from(this.extensions.keys())
	}

	/**
	 * 检查命名空间是否已注册
	 */
	hasExtension(namespace: string): boolean {
		return this.extensions.has(namespace)
	}
}
