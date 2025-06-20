import { BasePlugin, Plugin } from '../services'
// PluginC.ts

@Plugin({ name: 'PluginC', type: 'hook' })
export class PluginC extends BasePlugin {
	init(): void {
		this.ctx.logger.info('PluginC initialized')
	}
}
