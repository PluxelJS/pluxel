import { BasePlugin, Plugin } from '@pluxel/hmr'

@Plugin({ name: 'PluginB', type: 'hook' })
export class PluginB extends BasePlugin {
	init(): void {
		this.ctx.logger.info('PluginBa initialized')
	}

	doSomething(): void {
		// this.ctx.logger.info(this.ctx.caller, 'call from')
		this.ctx.logger.info('PluginB doing something...')
	}
}
