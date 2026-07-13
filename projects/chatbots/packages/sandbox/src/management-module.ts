import {
	defineManagementModule,
	ManagementPlacements,
	managementResource,
	managementUi,
	managementView,
	remoteView,
} from '@pluxel/runtime/management'
import type { ChatSandboxRpc } from './rpc.ts'
import type { SandboxMessage } from './plugin.ts'

export const ChatSandboxManagement = defineManagementModule({
	id: 'ChatSandboxPlugin',
	ui: managementUi(import.meta.url, './ui/index.tsx'),
	resources: {
		api: managementResource.api<ChatSandboxRpc>(),
		messages: managementResource.collection<SandboxMessage>(),
	},
	contributions: [
		managementView({
			id: 'sandbox-panel',
			placement: ManagementPlacements.PluginTabs,
			view: remoteView('SandboxPanel'),
			priority: 60,
			meta: { label: '消息沙箱', icon: 'test-pipe' },
		}),
		managementView({
			id: 'sandbox-route',
			placement: ManagementPlacements.PluginRoutes,
			view: remoteView('SandboxPanel'),
			meta: {
				route: {
					path: '/sandbox',
					title: '消息沙箱',
					icon: 'message-chatbot',
					addToNav: true,
					navPriority: 65,
				},
			},
		}),
	],
})
