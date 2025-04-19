// ScopedContext.ts
// 定义每个插件专用的上下文，既包含全局依赖，也支持 disposable 注册和释放

import type { GlobalPluginContext, Logger } from './GlobalContext'
import type { PluginMetadata } from './PluginDecorator'

export const CALLER_CTX = Symbol('CALLER_CTX')

export class PluginContext implements GlobalPluginContext {
	logger!: Logger
	public readonly name: string
	constructor(meta: PluginMetadata) {
		this.name = meta.name
	}
	public disposables: Array<() => void> = []
	fireDispose() {
		for (const fn of this.disposables) {
			fn()
		}

		this.disposables.length = 0
	}
}

export function createPluginContext(
	meta: PluginMetadata,
	globalCtx: GlobalPluginContext,
): PluginContext {
	const ctx = new PluginContext(meta)
	return Object.assign(ctx, globalCtx)
}
