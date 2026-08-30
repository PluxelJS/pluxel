// Read this when:
// - 你要挂最小插件级 HTTP 路由
// - 你不需要 worker，只想看 route base 和 path params

import { BasePlugin, formatPluginNodeReference, Plugin } from '@pluxel/runtime'

const ROUTE_BASE = '/demo/http'

@Plugin()
export class PluginHttpRoutesDemo extends BasePlugin {
	override init(): void {
		this.ctx.elysia.group(ROUTE_BASE, (app) =>
			app
				.get('/status', () => ({
					plugin: formatPluginNodeReference(this.ctx.pluginInfo.nodeAddress),
					ok: true,
					now: Date.now(),
				}))
				.get('/echo/:value', ({ params }) => ({
					value: params.value,
					length: params.value.length,
				})),
		)
	}
}
