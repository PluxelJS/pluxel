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
	views: (model) => ({
		Sandbox: workbench.view.remote({
			model: [model.commands, model.messages],
			placements: [
				workbench.place.slot({
					slot: workbench.slot.PluginTabs,
					priority: 60,
					label: '消息沙箱',
					icon: 'test-pipe',
				}),
				workbench.place.route({
					path: '/sandbox',
					title: '消息沙箱',
					icon: 'message-chatbot',
					navigation: { priority: 65 },
				}),
			],
		}),
	}),
})
