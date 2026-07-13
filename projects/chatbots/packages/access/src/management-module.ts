import {
	defineManagementModule,
	ManagementPlacements,
	managementResource,
	managementUi,
	managementView,
	remoteView,
} from '@pluxel/runtime/management'
import type { AccessOverviewDoc, ChatRole, ChatUser } from './model.ts'
import type { ChatAccessRpc } from './rpc.ts'

export const ChatAccessManagement = defineManagementModule({
	id: 'ChatAccessPlugin',
	ui: managementUi(import.meta.url, './ui/index.tsx'),
	resources: {
		api: managementResource.api<ChatAccessRpc>(),
		overview: managementResource.collection<AccessOverviewDoc>(),
		users: managementResource.collection<ChatUser>(),
		roles: managementResource.collection<ChatRole>(),
	},
	contributions: [
		managementView({
			id: 'access-panel',
			placement: ManagementPlacements.PluginTabs,
			view: remoteView('AccessPanel'),
			priority: 45,
			meta: { label: '用户与权限', icon: 'shield-lock' },
		}),
		managementView({
			id: 'access-route',
			placement: ManagementPlacements.PluginRoutes,
			view: remoteView('AccessPanel'),
			meta: {
				route: {
					path: '/access',
					title: '用户与权限',
					icon: 'users',
					addToNav: true,
					navPriority: 66,
				},
			},
		}),
	],
})
