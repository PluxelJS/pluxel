import { LoggerService } from '../../src/logger/LoggerService'
import { BasePlugin, Plugin } from '@pluxel/core/internal/test'
// PluginC.ts

@Plugin()
export class PluginC extends BasePlugin {
	protected init(): void {
		this.ctx.service(LoggerService).info('PluginC initialized')
	}

	doExampleLog() {
		this.ctx.service(LoggerService).info('这是来自我的log')
		this.ctx.caller?.service(LoggerService).info('这是来自调用我的地方的log')
	}
}

@Plugin()
export class PluginD extends BasePlugin {
	protected init(): void {
		this.ctx.service(LoggerService).info('PluginC initialized')
	}

	doSomethingElse() {
		this.ctx.service(LoggerService).info('这是来自我的log')
		this.ctx.caller?.service(LoggerService).info('这是来自调用我的地方的log')
	}
}
