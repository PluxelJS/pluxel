import { BasePlugin, Plugin } from '@pluxel/core/test'
// PluginC.ts

@Plugin()
export class PluginC extends BasePlugin {
	protected init(): void {
		this.ctx.logger.info('PluginC initialized')
	}

	doExampleLog() {
		this.ctx.logger.info('这是来自我的log')
		this.ctx.caller?.logger.info('这是来自调用我的地方的log')
	}
}

@Plugin()
export class PluginD extends BasePlugin {
	protected init(): void {
		this.ctx.logger.info('PluginC initialized')
	}

	doSomethingElse() {
		this.ctx.logger.info('这是来自我的log')
		this.ctx.caller?.logger.info('这是来自调用我的地方的log')
	}
}
