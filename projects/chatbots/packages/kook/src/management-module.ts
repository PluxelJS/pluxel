import {
	defineManagementModule,
	ManagementPlacements,
	managementResource,
	managementUi,
	managementView,
	remoteView,
} from '@pluxel/runtime/management'
import type { KookManagementRpc, KookSettingsDoc, KookStatusDoc } from './management.ts'

export const KookManagementModule = defineManagementModule({
	id: 'KookPlugin',
	ui: managementUi(import.meta.url, './ui/index.tsx'),
	resources: {
		api: managementResource.api<KookManagementRpc>(),
		settings: managementResource.collection<KookSettingsDoc>(),
		status: managementResource.collection<KookStatusDoc>(),
	},
	contributions: [
		managementView({
			id: 'settings-panel',
			placement: ManagementPlacements.PluginTabs,
			view: remoteView('KookSettingsPanel'),
			priority: 50,
			meta: { label: 'KOOK 管理', icon: 'settings' },
		}),
		managementView({
			id: 'settings-route',
			placement: ManagementPlacements.PluginRoutes,
			view: remoteView('KookSettingsPanel'),
			meta: {
				route: {
					path: '/settings',
					title: 'KOOK Bot',
					icon: 'brand-discord',
					addToNav: true,
					navPriority: 70,
				},
			},
		}),
	],
})
