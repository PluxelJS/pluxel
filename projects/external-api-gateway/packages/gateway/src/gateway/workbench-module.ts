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
	views: {
		HeaderAction: workbench.view.slot({
			slot: workbench.slot.GlobalHeaderActions,
			model: ['status'],
			priority: 110,
		}),
		GatewayPanel: workbench.view.slot({
			slot: workbench.slot.PluginTabs,
			model: ['commands', 'tokens', 'status'],
			priority: 30,
			label: '外部访问',
			icon: 'shield-lock',
		}),
		GatewayDashboard: workbench.view.route({
			path: '/dashboard',
			title: 'External Gateway RPC',
			icon: 'api',
			navigation: { priority: 100 },
			model: ['commands', 'tokens', 'status'],
		}),
	},
})
