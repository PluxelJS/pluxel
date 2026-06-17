import { createYoga } from 'graphql-yoga'
import { BasePlugin, Plugin } from '@pluxel/runtime'
import { ui } from '@pluxel/runtime/plugin'
import { createCommercialContext } from './context.ts'
import { createSchema } from './schema.ts'

const pluginUi = ui('./web/client/main.tsx')

export class StaticCommercialPlugin extends BasePlugin {
	override init(): void {
		pluginUi.bind(this.ctx)

		const yoga = createYoga({
			schema: createSchema(),
			graphqlEndpoint: '/__pluxel/plugins/StaticCommercialPlugin/graphql',
			context: (initial) => createCommercialContext(initial, this.ctx),
			maskedErrors: process.env.NODE_ENV === 'production',
			logging: process.env.NODE_ENV === 'development' ? 'debug' : 'warn',
		})

		this.ctx.http.plugin.routes(
			(app) =>
				app.all('/graphql', async ({ request, set }) => {
					const response = await yoga.fetch(request)
					set.status = response.status
					response.headers.forEach((value, key) => {
						set.headers[key] = value
					})
					return response.text()
				}),
			{
				path: '/',
				id: 'StaticCommercialPlugin:graphql',
			},
		)

		this.ctx.logger.info('Static commercial GraphQL mounted', {
			path: this.ctx.http.plugin.base('/graphql'),
		})
	}
}

Plugin({ name: 'StaticCommercialPlugin' })(StaticCommercialPlugin)
