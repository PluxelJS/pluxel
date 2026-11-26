import { host, market } from './application'
import { marketEnvironment, type MarketBindings } from './bindings'
import { isHostedRegistryPath, hasHostedRegistryBindings } from './registry/route'

export default {
	fetch(request, env, ctx) {
		if (isHostedRegistryPath(new URL(request.url).pathname) && !hasHostedRegistryBindings(env))
			return new Response(null, { status: 404 })
		return host.run({ env: marketEnvironment(env), signal: request.signal, ctx }, async (sdk) => {
			const { instance } = await sdk.plugin(market.nodeAddress()).instance()
			return instance.fetch(request, env)
		})
	},
	async scheduled(_controller, env, ctx) {
		await host.run({ env: marketEnvironment(env), ctx }, async (sdk) => {
			const { instance } = await sdk.plugin(market.nodeAddress()).instance()
			return instance.processNotifications(env)
		})
	},
} satisfies ExportedHandler<MarketBindings>
