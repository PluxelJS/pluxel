import { workbench } from '@pluxel/runtime/workbench'
import type { GatewayStatusDoc, GatewayTokenDoc } from '@repo/external-api-gateway-shared/gateway'
import type { GatewayAdminRpc } from './plugin.ts'

export const ExternalGatewayWorkbench = workbench.define({
	plugin: 'ExternalGatewayPlugin',
	entry: workbench.entry(import.meta.url, './ui/index.tsx'),
	model: {
		commands: workbench.model.rpc<GatewayAdminRpc>(),
		tokens: workbench.model.collection<GatewayTokenDoc>(),
		status: workbench.model.collection<GatewayStatusDoc>(),
	},
	views: (model) => ({
		HeaderAction: workbench.view.remote({
			placements: [
				workbench.place.slot({ slot: workbench.slot.GlobalHeaderActions, priority: 110 }),
			],
		}),
		GatewayPanel: workbench.view.remote({
			model: [model.commands, model.tokens, model.status],
			placements: [
				workbench.place.slot({
					slot: workbench.slot.PluginTabs,
					priority: 30,
					label: '外部访问',
					icon: 'shield-lock',
				}),
			],
		}),
		GatewayDashboard: workbench.view.remote({
			model: [model.commands, model.tokens, model.status],
			placements: [
				workbench.place.route({
					path: '/dashboard',
					title: 'External Gateway RPC',
					icon: 'api',
					navigation: { priority: 100 },
				}),
			],
		}),
	}),
})
