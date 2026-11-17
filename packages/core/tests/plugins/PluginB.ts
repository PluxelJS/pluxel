import { LoggerService } from '../../src/logger/LoggerService'
import { BasePlugin, Plugin } from '@pluxel/core/internal/test'

@Plugin()
export class PluginB extends BasePlugin {
	protected init(): void {
		this.ctx.service(LoggerService).info('PluginB initialized')
	}

	doSomething(): void {
		// this.ctx.service(LoggerService).info(this.ctx.caller, 'call from')
		this.ctx.service(LoggerService).info('PluginB doing something...')
	}
}
