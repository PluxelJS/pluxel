import type { Context } from '@pluxel/context'

export const PLUGIN_CTX = Symbol('PLUGIN_CTX')
export abstract class BasePlugin {
	public [PLUGIN_CTX]!: Context

	// 插件内部通过 this.ctx 访问系统依赖及注册 disposable
	public get ctx(): Context {
		if (!this[PLUGIN_CTX]) {
			throw new Error('Plugin context has not been set.')
		}
		return this[PLUGIN_CTX]
	}

	public get caller() {
		if (!this[PLUGIN_CTX]) {
			throw new Error('Plugin context has not been set.')
		}
		return this[PLUGIN_CTX].caller
	}

	// 生命周期方法，插件必须实现 init 来完成初始化
	abstract init(): void
}
