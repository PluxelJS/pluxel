import { workbenchContract } from '@pluxel/runtime/workbench/contract'
import { jsonObjectSchema } from '@repo/chatbots-adapter-kit/wire-schema'
import type { ChatBlock, ChatMessage } from '@repo/chatbots-contracts'

export type SandboxMessage = ChatMessage & { direction: 'inbound' | 'outbound' }
export type SandboxInput = {
	text?: string
	content?: ChatBlock[]
	conversationId?: string
	actorId?: string
	displayName?: string
}

export interface ChatSandboxCommands {
	send(input: SandboxInput): Promise<{ message: SandboxMessage; replies: SandboxMessage[] }>
	reset(): { ok: true }
	status(): unknown
}

export const ChatSandboxUi = workbenchContract.define({
	resources: {
		commands: workbenchContract.rpc<ChatSandboxCommands>(),
		messages: workbenchContract.liveQuery({ row: jsonObjectSchema<SandboxMessage>(), key: 'id' }),
	},
	views: {
		Sandbox: {
			placements: [
				workbenchContract.slot(workbenchContract.slots.PluginTabs, {
					order: 60,
					label: '消息沙箱',
					icon: workbenchContract.icons.TestPipe,
				}),
				workbenchContract.route('/sandbox', {
					title: '消息沙箱',
					icon: workbenchContract.icons.MessageChatbot,
					order: 65,
				}),
			],
		},
	},
})
