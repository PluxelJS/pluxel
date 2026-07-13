import {
	defineManagementModule,
	ManagementPlacements,
	managementResource,
	managementUi,
	managementView,
	remoteView,
} from '@pluxel/runtime/management'

export const PluginStatusBadgeManagement = defineManagementModule({
	id: 'PluginStatusBadge',
	ui: managementUi(import.meta.url, './PluginStatusBadge/ui/StatusBadge.tsx'),
	resources: { activity: managementResource.stream<{ now: number }>() },
	contributions: [
		managementView({
			id: 'status-badge',
			placement: ManagementPlacements.GlobalHeaderActions,
			view: remoteView('StatusBadge'),
			priority: 50,
		}),
	],
})
