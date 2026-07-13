import {
	defineManagementModule,
	ManagementPlacements,
	managementResource,
	managementUi,
	managementView,
	remoteView,
} from '@pluxel/runtime/management'
import type { GatewayStatusDoc, GatewayTokenDoc } from '@repo/external-api-gateway-shared/gateway'
import type { GatewayAdminRpc } from './plugin.ts'

export const ExternalGatewayManagement = defineManagementModule({
	id: 'ExternalGatewayPlugin',
	ui: managementUi(import.meta.url, './ui/index.tsx'),
	resources: {
		api: managementResource.api<GatewayAdminRpc>(),
		tokens: managementResource.collection<GatewayTokenDoc>(),
		status: managementResource.collection<GatewayStatusDoc>(),
	},
	contributions: [
		managementView({
			id: 'header-action',
			placement: ManagementPlacements.GlobalHeaderActions,
			view: remoteView('HeaderAction'),
			priority: 110,
		}),
		managementView({
			id: 'tokens',
			placement: ManagementPlacements.PluginTabs,
			view: remoteView('GatewayPanel'),
			priority: 30,
			meta: { label: '外部访问', icon: 'shield-lock' },
		}),
		managementView({
			id: 'dashboard',
			placement: ManagementPlacements.PluginRoutes,
			view: remoteView('GatewayDashboard'),
			meta: {
				route: {
					path: '/dashboard',
					title: 'External Gateway RPC',
					icon: 'api',
					addToNav: true,
					navPriority: 100,
				},
			},
		}),
	],
})
