import { BasePlugin, Plugin } from '@pluxel/hmr'
// biome-ignore lint/correctness/noUnusedImports: fixture import edge for extraction tests
import { demoBookModule } from './demo-parent'
import { test1 } from './testconfig'

@Plugin({ name: 'PluginC', type: 'hook' })
export class PluginC extends BasePlugin {
	private test1 = this.configs.use(test1)
	override init(): void {
		void this.test1

		this.ctx.logger.info('PluginC initialized')
	}
}
