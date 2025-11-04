import { BasePlugin, Plugin } from '@pluxel/hmr'
import * as v from 'valibot'
// biome-ignore lint/correctness/noUnusedImports: <explanation>
import { demoBookModule } from './demo-parent'

@Plugin({ name: 'PluginC', type: 'hook' })
export class PluginC extends BasePlugin {
	init(): void {
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
