import { workbench } from '@pluxel/runtime/workbench'
import type { ChatSandboxRpc } from './rpc.ts'
import type { SandboxMessage } from './plugin.ts'

export const ChatSandboxWorkbench = workbench.define({
	plugin: 'ChatSandboxPlugin',
	entry: workbench.entry(import.meta.url, './ui/index.tsx'),
	model: {
		commands: workbench.model.rpc<ChatSandboxRpc>(),
		messages: workbench.model.collection<SandboxMessage>(),
	},
	views: {
		SandboxPanel: workbench.view.slot({
			slot: workbench.slot.PluginTabs,
			model: ['commands', 'messages'],
			priority: 60,
			label: '消息沙箱',
			icon: 'test-pipe',
		}),
		SandboxRoute: workbench.view.route({
			path: '/sandbox',
			title: '消息沙箱',
			icon: 'message-chatbot',
			navigation: { priority: 65 },
			model: ['commands', 'messages'],
		}),
	},
})
