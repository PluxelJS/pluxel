import {
	defineManagementModule,
	ManagementPlacements,
	managementResource,
	managementUi,
	managementView,
	remoteView,
} from '@pluxel/runtime/management'
import type { YiqichaSettingsDoc, YiqichaStatusDoc, YiqichaTestRunDoc } from './contracts.ts'
import type { YiqichaProviderRpc } from './plugin.ts'

export const YiqichaManagement = defineManagementModule({
	id: 'YiqichaProviderPlugin',
	ui: managementUi(import.meta.url, './ui/index.tsx'),
	resources: {
		api: managementResource.api<YiqichaProviderRpc>(),
		settings: managementResource.collection<YiqichaSettingsDoc>(),
		status: managementResource.collection<YiqichaStatusDoc>(),
		history: managementResource.collection<YiqichaTestRunDoc>(),
	},
	contributions: [
		managementView({
			id: 'header-action',
			placement: ManagementPlacements.GlobalHeaderActions,
			view: remoteView('HeaderAction'),
			priority: 88,
		}),
		managementView({
			id: 'api-test',
			placement: ManagementPlacements.PluginTabs,
			view: remoteView('YiqichaApiPanel'),
			priority: 30,
			meta: { label: '接口测试', icon: 'search' },
		}),
		managementView({
			id: 'settings',
			placement: ManagementPlacements.PluginTabs,
			view: remoteView('YiqichaSettingsPanel'),
			priority: 20,
			meta: { label: '设置', icon: 'key' },
		}),
		managementView({
			id: 'history',
			placement: ManagementPlacements.PluginTabs,
			view: remoteView('YiqichaHistoryPanel'),
			priority: 10,
			meta: { label: '历史', icon: 'history' },
		}),
		managementView({
			id: 'dashboard',
			placement: ManagementPlacements.PluginRoutes,
			view: remoteView('YiqichaDashboard'),
			meta: {
				route: {
					path: '/dashboard',
					title: 'YiQiCha Provider',
					icon: 'server-cog',
					addToNav: true,
					navPriority: 78,
				},
			},
		}),
	],
})
