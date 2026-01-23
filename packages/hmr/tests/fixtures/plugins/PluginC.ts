import { BasePlugin, Plugin } from '@pluxel/hmr'
import * as v from 'valibot'
// biome-ignore lint/correctness/noUnusedImports: fixture import edge for extraction tests
import { demoBookModule } from './demo-parent'
import { test1 } from './testconfig'

@Plugin({ name: 'PluginC', type: 'hook' })
export class PluginC extends BasePlugin {
	private test1 = this.configs.use(test1)
	override init(): void {
		void this.test1

		this.ctx.logger.info('PluginC initialized')

		const graphService = this.ctx.graphql
		const { resolver, query } = graphService.factory
		const _helloResolver = resolver({
			hello: query(v.string())
				.input({ name: v.nullish(v.string(), 'World') })
				.resolve(({ name }) => `Hello, ${name}!`),
		})
	}
}
