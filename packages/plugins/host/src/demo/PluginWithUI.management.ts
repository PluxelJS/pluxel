import {
	defineManagementModule,
	ManagementPlacements,
	managementResource,
	managementUi,
	managementView,
	remoteView,
} from '@pluxel/runtime/management'
import type {
	DemoEvent,
	PluginWithUIRpc,
	PluginWithUISsePayload,
	PluginWithUIStatusDoc,
} from './PluginWithUI'

export const PluginWithUIManagement = defineManagementModule({
	id: 'PluginWithUI',
	ui: managementUi(import.meta.url, './PluginWithUI/ui/index.tsx'),
	resources: {
		api: managementResource.api<PluginWithUIRpc>(),
		status: managementResource.collection<PluginWithUIStatusDoc>(),
		events: managementResource.collection<DemoEvent>(),
		activity: managementResource.stream<PluginWithUISsePayload>(),
	},
	contributions: [
		managementView({
			id: 'header-action',
			placement: ManagementPlacements.GlobalHeaderActions,
			view: remoteView('HeaderAction'),
			priority: 100,
		}),
		managementView({
			id: 'overview',
			placement: ManagementPlacements.PluginTabs,
			view: remoteView('OverviewPanel'),
			priority: 20,
			meta: { label: '概览' },
		}),
		managementView({
			id: 'events',
			placement: ManagementPlacements.PluginTabs,
			view: remoteView('EventsPanel'),
			priority: 19,
			meta: { label: '事件' },
		}),
		managementView({
			id: 'streams',
			placement: ManagementPlacements.PluginTabs,
			view: remoteView('StreamsPanel'),
			priority: 18,
			meta: { label: 'Streams' },
		}),
		managementView({
			id: 'plugin-info',
			placement: ManagementPlacements.PluginInfo,
			view: remoteView('PluginInfo'),
			priority: 10,
		}),
		managementView({
			id: 'dashboard-route',
			placement: ManagementPlacements.PluginRoutes,
			view: remoteView('RoutePage'),
			meta: {
				route: {
					path: '/dashboard',
					title: 'PluginWithUI Dashboard',
					addToNav: true,
					navPriority: 50,
				},
			},
		}),
		managementView({
			id: 'notes-route',
			placement: ManagementPlacements.PluginRoutes,
			view: remoteView('RoutePage'),
			meta: { route: { path: '/notes', title: 'PluginWithUI Notes' } },
		}),
		managementView({
			id: 'standalone-route',
			placement: ManagementPlacements.PluginRoutes,
			view: remoteView('StandaloneRoutePage'),
			meta: {
				route: {
					path: '/standalone',
					title: 'PluginWithUI Standalone',
					frame: 'standalone',
				},
			},
		}),
	],
})
