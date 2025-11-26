import { BasePlugin, Plugin } from '@pluxel/core'

@Plugin({ name: 'PluginB', type: 'hook' })
export class PluginB extends BasePlugin {
	init(): void {
		this.ctx.logger.info('PluginB initialized')
		throw new Error('aaaaaa')
	}

	doSomething(): void {
		// this.ctx.logger.info(this.ctx.caller, 'call from')
		this.ctx.logger.info('PluginB doing something...')
	}
}
