// Read this when:
// - 你要挂最小插件级 HTTP 路由
// - 你不需要 worker，只想看 route base、path params 和 builtin doc 说明

import { BasePlugin, Plugin } from '@pluxel/runtime'
import {
	defineManagementModule,
	ManagementPlacements,
	managementDoc,
	managementDocument,
	managementView,
} from '@pluxel/runtime/management'

const ROUTE_BASE = '/http-demo'
const d = managementDoc({} as const)
const HttpRoutesManagement = defineManagementModule({
	id: 'PluginHttpRoutesDemo',
	contributions: [
		managementView({
			id: 'http-routes',
			placement: ManagementPlacements.PluginTabs,
			meta: { label: 'HTTP Routes' },
			view: managementDocument({
				title: 'HTTP Routes Demo',
				content: d`
					Route base: \`/__pluxel/plugins/PluginHttpRoutesDemo${ROUTE_BASE}\`.

					- \`GET /status\`: returns a small health payload.
					- \`GET /echo/:value\`: returns the path param and length.
				`,
			}),
		}),
	],
})

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

		this.ctx.management.mount(HttpRoutesManagement, {})
	}
}
