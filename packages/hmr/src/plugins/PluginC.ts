import { BasePlugin, Plugin } from '@pluxel/core'
import * as v from 'valibot'
import { bookResolver } from './demo-parent'

@Plugin({ name: 'PluginC', type: 'hook' })
export class PluginC extends BasePlugin {
	init(): void {
		this.ctx.logger.info('PluginC initialized')

		const graphService = this.ctx.graphqlService
		const { resolver, query } = graphService.factory
		const helloResolver = resolver({
			hello: query(v.string())
				.input({ name: v.nullish(v.string(), 'World') })
				.resolve(({ name }) => `Hello, ${name}!`),
		})
		graphService.useModule(helloResolver)
		graphService.useModule(bookResolver)
	}
}
