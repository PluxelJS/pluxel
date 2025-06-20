import { BasePlugin, Plugin } from '../services'
// PluginB.ts
import { PluginC } from './PluginC'

@Plugin({ name: 'PluginB', type: 'hook' })
export class PluginB extends BasePlugin {
	init(): void {
		this.ctx.logger.info('PluginB initialized')
	}

	doSomething(): void {
		// this.ctx.logger.info(this.ctx.caller, 'call from')
		this.ctx.logger.info('PluginB doing something...')
	}
}
