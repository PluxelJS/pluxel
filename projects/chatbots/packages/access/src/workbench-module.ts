import { workbench } from '@pluxel/runtime/workbench'
import type { AccessOverviewDoc, ChatRole, ChatUser } from './model.ts'
import type { ChatAccessRpc } from './rpc.ts'

export const ChatAccessWorkbench = workbench.define({
	plugin: 'ChatAccessPlugin',
	entry: workbench.entry(import.meta.url, './ui/index.tsx'),
	model: {
		commands: workbench.model.rpc<ChatAccessRpc>(),
		overview: workbench.model.collection<AccessOverviewDoc>(),
		users: workbench.model.collection<ChatUser>(),
		roles: workbench.model.collection<ChatRole>(),
	},
	views: {
		AccessPanel: workbench.view.slot({
			slot: workbench.slot.PluginTabs,
			model: ['commands', 'overview', 'users', 'roles'],
			priority: 45,
			label: '用户与权限',
			icon: 'shield-lock',
		}),
		AccessRoute: workbench.view.route({
			path: '/access',
			title: '用户与权限',
			icon: 'users',
			navigation: { priority: 66 },
			model: ['commands', 'overview', 'users', 'roles'],
		}),
	},
})
