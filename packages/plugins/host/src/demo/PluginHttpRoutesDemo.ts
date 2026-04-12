// Read this when:
// - 你要挂最小插件级 HTTP 路由
// - 你不需要 worker，只想看 route base、path params 和 builtin doc 说明

import { BasePlugin, Plugin } from '@pluxel/runtime'
import { doc } from '@pluxel/runtime/services'

const ROUTE_BASE = '/http-demo'

@Plugin({ name: 'PluginHttpRoutesDemo' })
export class PluginHttpRoutesDemo extends BasePlugin {
	override init(): void {
		this.ctx.http.plugin.routes(
			(app) =>
				app
					.get('/status', () => ({
						plugin: this.ctx.pluginInfo.id,
						ok: true,
						now: Date.now(),
					}))
					.get('/echo/:value', ({ params }) => ({
						value: params.value,
						length: params.value.length,
					})),
			{
				path: ROUTE_BASE,
				id: 'PluginHttpRoutesDemo:http',
			},
		)

		this.registerDoc()
	}

	private registerDoc() {
		const d = doc({} as const)

		this.ctx.ext.ui.builtin.doc({
			id: 'plugin-http-routes-demo',
			point: 'plugin:tabs',
			title: 'HTTP Routes Demo',
			meta: {
				label: 'HTTP Routes',
			},
			content: d`
				Route base: \`/__pluxel/plugins/PluginHttpRoutesDemo${ROUTE_BASE}\`.

				Endpoints:
				- \`GET /status\`: returns a small health payload.
				- \`GET /echo/:value\`: returns the path param and length.
			`,
		})
	}
}
