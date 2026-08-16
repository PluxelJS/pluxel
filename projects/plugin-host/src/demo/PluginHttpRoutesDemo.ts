// Read this when:
// - 你要挂最小插件级 HTTP 路由
// - 你不需要 worker，只想看 route base、path params 和 builtin doc 说明

import { BasePlugin, formatPluginNodeAddress, Plugin } from '@pluxel/runtime'
import { workbench, workbenchDoc } from '@pluxel/runtime/workbench'
import { workbenchContract } from '@pluxel/runtime/workbench/contract'

const ROUTE_BASE = '/demo/http'
const d = workbenchDoc()
const HttpRoutesUi = workbenchContract.define({
	views: {
		documentation: workbenchContract.document({
			placements: [workbenchContract.tab({ label: 'HTTP Routes' })],
			title: 'HTTP Routes Demo',
			content: d`
					Public route base: \`${ROUTE_BASE}\`.

					- \`GET /status\`: returns a small health payload.
					- \`GET /echo/:value\`: returns the path param and length.
				`,
		}),
	},
})
const HttpRoutesWorkbench = workbench.extension({ contract: HttpRoutesUi })

@Plugin()
export class PluginHttpRoutesDemo extends BasePlugin {
	override init(): void {
		this.ctx.http.plugin.routes(
			(app) =>
				app
					.get('/status', () => ({
						plugin: formatPluginNodeAddress(this.ctx.pluginInfo.nodeAddress),
						ok: true,
						now: Date.now(),
					}))
					.get('/echo/:value', ({ params }) => ({
						value: params.value,
						length: params.value.length,
					})),
			{
				publicPath: ROUTE_BASE,
				id: 'http-demo',
			},
		)

		this.ctx.workbench.mount(HttpRoutesWorkbench, {})
	}
}
