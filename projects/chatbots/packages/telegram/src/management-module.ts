import {
	defineManagementModule,
	ManagementPlacements,
	managementResource,
	managementUi,
	managementView,
	remoteView,
} from '@pluxel/runtime/management'
import type { TelegramManagementRpc, TelegramSettingsDoc, TelegramStatusDoc } from './management.ts'

export const TelegramManagementModule = defineManagementModule({
	id: 'TelegramPlugin',
	ui: managementUi(import.meta.url, './ui/index.tsx'),
	resources: {
		api: managementResource.api<TelegramManagementRpc>(),
		settings: managementResource.collection<TelegramSettingsDoc>(),
		status: managementResource.collection<TelegramStatusDoc>(),
	},
	contributions: [
		managementView({
			id: 'settings-panel',
			placement: ManagementPlacements.PluginTabs,
			view: remoteView('TelegramSettingsPanel'),
			priority: 50,
			meta: { label: 'Telegram 管理', icon: 'settings' },
		}),
		managementView({
			id: 'settings-route',
			placement: ManagementPlacements.PluginRoutes,
			view: remoteView('TelegramSettingsPanel'),
			meta: {
				route: {
					path: '/settings',
					title: 'Telegram Bot',
					icon: 'brand-telegram',
					addToNav: true,
					navPriority: 69,
				},
			},
		}),
	],
})
