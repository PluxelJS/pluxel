import { BasePlugin } from '../core/PluginBase'
// PluginB.ts
import { Plugin } from '../core/PluginDecorator'
import { PluginC } from './PluginC'

@Plugin({ name: 'PluginB', type: 'hook' })
export class PluginB extends BasePlugin {
	init(): void {
		this.ctx.logger.info('PluginB initialized')
	}

	doSomething(): void {
		this.ctx.logger.info(this.getCallerContext(), `call from`)
		this.ctx.logger.info('PluginB doing something...')
	}
}
