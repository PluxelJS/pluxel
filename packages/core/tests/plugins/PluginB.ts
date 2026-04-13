import { BasePlugin, Plugin } from '@pluxel/test'

@Plugin()
export class PluginB extends BasePlugin {
	protected init(): void {
		this.ctx.logger.info('PluginB initialized')
	}

	doSomething(): void {
		// this.ctx.logger.info(this.ctx.caller, 'call from')
		this.ctx.logger.info('PluginB doing something...')
	}
}
