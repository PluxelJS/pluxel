import { BasePlugin, Config, Plugin } from '@pluxel/core'
import * as v from 'valibot'
// biome-ignore lint/correctness/noUnusedImports: <explanation>
import { demoBookModule } from './demo-parent'
import { test1 } from './testconfig'

@Plugin({ name: 'PluginC', type: 'hook' })
export class PluginC extends BasePlugin {
	@Config(test1)
	private test1!: Config<typeof test1>
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
