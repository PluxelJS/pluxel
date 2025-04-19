import { BasePlugin } from '../core/BasePlugin'
// PluginC.ts
import { Plugin } from '../core/PluginDecorator'

@Plugin({ name: 'PluginC', type: 'hook' })
export class PluginC extends BasePlugin {
	init(): void {
		this.ctx.logger.info('PluginC initialized')
	}
}
