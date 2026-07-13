import {
	defineManagementModule,
	ManagementPlacements,
	managementResource,
	managementUi,
	managementView,
	remoteView,
} from '@pluxel/runtime/management'
import type {
	BillingOverviewDoc,
	BillingProviderSummaryDoc,
	BillingRateDoc,
	BillingUsageRecord,
	BillingUserSummaryDoc,
} from './contracts.ts'
import type { UsageBillingRpc } from './plugin.ts'

export const UsageBillingManagement = defineManagementModule({
	id: 'UsageBillingPlugin',
	ui: managementUi(import.meta.url, './ui/index.tsx'),
	resources: {
		api: managementResource.api<UsageBillingRpc>(),
		overview: managementResource.collection<BillingOverviewDoc>(),
		records: managementResource.collection<BillingUsageRecord>(),
		users: managementResource.collection<BillingUserSummaryDoc>(),
		providers: managementResource.collection<BillingProviderSummaryDoc>(),
		rates: managementResource.collection<BillingRateDoc>(),
	},
	contributions: [
		managementView({
			id: 'header-action',
			placement: ManagementPlacements.GlobalHeaderActions,
			view: remoteView('HeaderAction'),
			priority: 100,
		}),
		managementView({
			id: 'billing-panel',
			placement: ManagementPlacements.PluginTabs,
			view: remoteView('BillingPanel'),
			priority: 20,
			meta: { label: '用量总览', icon: 'chart-bar' },
		}),
		managementView({
			id: 'dashboard-route',
			placement: ManagementPlacements.PluginRoutes,
			view: remoteView('BillingDashboard'),
			meta: {
				route: {
					path: '/dashboard',
					title: 'Usage Billing',
					icon: 'receipt',
					addToNav: true,
					navPriority: 90,
				},
			},
		}),
	],
})
