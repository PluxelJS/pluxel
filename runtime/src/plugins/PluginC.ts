import { BasePlugin, Plugin } from '@pluxel/hmr'
// PluginC.ts

@Plugin({ name: 'PluginC' })
export class PluginC extends BasePlugin {
	init(): void {
		this.ctx.logger.info('PluginCaaa initialized')
	}
}
