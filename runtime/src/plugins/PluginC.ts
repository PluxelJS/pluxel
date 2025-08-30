import { BasePlugin, Plugin } from '@pluxel/hmr'
// PluginC.ts

@Plugin({ name: 'PluginC', type: 'hook' })
export class PluginC extends BasePlugin {
	init(): void {
		this.ctx.logger.info('PluginCaaa initialized')
	}
}
