import {
	defineManagementModule,
	ManagementPlacements,
	managementResource,
	managementUi,
	managementView,
	remoteView,
} from '@pluxel/runtime/management'
import type { ZhipuSettingsDoc, ZhipuStatusDoc, ZhipuTestRunDoc } from './contracts.ts'
import type { ZhipuProviderRpc } from './plugin.ts'

export const ZhipuManagement = defineManagementModule({
	id: 'ZhipuProviderPlugin',
	ui: managementUi(import.meta.url, './ui/index.tsx'),
	resources: {
		api: managementResource.api<ZhipuProviderRpc>(),
		settings: managementResource.collection<ZhipuSettingsDoc>(),
		status: managementResource.collection<ZhipuStatusDoc>(),
		history: managementResource.collection<ZhipuTestRunDoc>(),
	},
	contributions: [
		managementView({
			id: 'header-action',
			placement: ManagementPlacements.GlobalHeaderActions,
			view: remoteView('HeaderAction'),
			priority: 90,
		}),
		managementView({
			id: 'ocr',
			placement: ManagementPlacements.PluginTabs,
			view: remoteView('ZhipuOcrPanel'),
			priority: 30,
			meta: { label: 'OCR', icon: 'cloud-upload' },
		}),
		managementView({
			id: 'tools',
			placement: ManagementPlacements.PluginTabs,
			view: remoteView('ZhipuApiPanel'),
			priority: 25,
			meta: { label: '模型/工具', icon: 'plug-connected' },
		}),
		managementView({
			id: 'settings',
			placement: ManagementPlacements.PluginTabs,
			view: remoteView('ZhipuSettingsPanel'),
			priority: 20,
			meta: { label: '设置' },
		}),
		managementView({
			id: 'history',
			placement: ManagementPlacements.PluginTabs,
			view: remoteView('ZhipuHistoryPanel'),
			priority: 10,
			meta: { label: '历史', icon: 'history' },
		}),
		managementView({
			id: 'dashboard',
			placement: ManagementPlacements.PluginRoutes,
			view: remoteView('ZhipuDashboard'),
			meta: {
				route: {
					path: '/dashboard',
					title: 'Zhipu Provider',
					icon: 'text-recognition',
					addToNav: true,
					navPriority: 80,
				},
			},
		}),
	],
})
