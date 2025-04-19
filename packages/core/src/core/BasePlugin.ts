import { CALLER_CTX, type PluginContext } from './PluginContext'

export abstract class BasePlugin {
	private _ctx!: PluginContext

	// 系统调用此方法注入插件上下文
	public setContext(ctx: PluginContext) {
		this._ctx = ctx
	}

	// 插件内部通过 this.ctx 访问系统依赖及注册 disposable
	protected get ctx(): PluginContext {
		if (!this._ctx) {
			throw new Error('Plugin context has not been set.')
		}
		return this._ctx
	}

	// 生命周期方法，插件必须实现 init 来完成初始化
	abstract init(): void

	/** 依赖方方法里可直接用这个拿到注入时绑定的 callerContext */
	protected getCallerContext(): PluginContext | undefined {
		// biome-ignore lint/suspicious/noExplicitAny: <explanation>
		return (this as any)[CALLER_CTX]
	}
}
