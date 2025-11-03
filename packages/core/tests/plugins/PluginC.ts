import { BasePlugin, Plugin } from '../context'
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
