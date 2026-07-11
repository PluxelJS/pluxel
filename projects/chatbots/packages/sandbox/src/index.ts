import { BasePlugin, Plugin } from '@pluxel/runtime'
import {
	ChatHubPlugin,
	contentText,
	normalizeContent,
	type ChatBlock,
	type ChatMessage,
	type ChatSendRequest,
} from '@repo/chatbots-hub'

export type SandboxMessage = ChatMessage & { direction: 'inbound' | 'outbound' }

type SandboxInput = {
	text?: string
	content?: ChatBlock[]
	conversationId?: string
	actorId?: string
	displayName?: string
}

const MAX_MESSAGES = 500

@Plugin({ name: 'ChatSandboxPlugin', dependencies: [ChatHubPlugin] })
export class ChatSandboxPlugin extends BasePlugin {
	private messages: SandboxMessage[] = []
	private sequence = 1

	constructor(private readonly hub: ChatHubPlugin) {
		super()
	}

	override init(): void {
		const dispose = this.hub.registerTransport({
			name: 'sandbox',
			send: async (request) => this.captureOutbound(request),
		})
		this.ctx.effects.defer(dispose)
		this.ctx.http.plugin.routes(
			(app) =>
				app
					.get('/status', () => ({
						ok: true,
						messages: this.messages.length,
						transports: this.hub.listTransports(),
						handlers: this.hub.listHandlers(),
					}))
					.get('/messages', () => ({ messages: this.messages }))
					.post('/messages', async ({ body, status }) => {
						try {
							return await this.accept(body as SandboxInput)
						} catch (error) {
							return status(400, { error: error instanceof Error ? error.message : String(error) })
						}
					})
					.post('/reset', () => {
						this.messages = []
						this.sequence = 1
						return { ok: true }
					}),
			{ path: '/api', id: 'ChatSandboxPlugin:api' },
		)
	}

	private async accept(
		input: SandboxInput,
	): Promise<{ message: SandboxMessage; replies: SandboxMessage[] }> {
		const blocks = input.content?.length
			? normalizeContent(input.content)
			: normalizeContent(input.text ?? '')
		if (blocks.length === 0 || !contentText(blocks))
			throw new Error('A non-empty text or content field is required')
		const message: SandboxMessage = {
			id: `in-${this.sequence++}`,
			direction: 'inbound',
			transport: 'sandbox',
			conversation: { id: input.conversationId ?? 'default', kind: 'direct', title: 'Sandbox' },
			actor: {
				id: input.actorId ?? 'sandbox-user',
				displayName: input.displayName ?? 'Sandbox User',
			},
			content: blocks,
			text: contentText(blocks),
			createdAt: Date.now(),
		}
		this.append(message)
		const before = this.messages.length
		await this.hub.receive(message)
		return {
			message,
			replies: this.messages.slice(before).filter((item) => item.direction === 'outbound'),
		}
	}

	private async captureOutbound(request: ChatSendRequest) {
		const blocks = normalizeContent(request.content)
		const message: SandboxMessage = {
			id: `out-${this.sequence++}`,
			direction: 'outbound',
			transport: 'sandbox',
			conversation: { id: request.conversationId, kind: 'direct', title: 'Sandbox' },
			actor: { id: 'chatbot', displayName: 'Chatbot', isBot: true },
			content: blocks,
			text: contentText(blocks),
			createdAt: Date.now(),
			replyToId: request.replyToId,
		}
		this.append(message)
		return { messageId: message.id }
	}

	private append(message: SandboxMessage): void {
		this.messages.push(message)
		if (this.messages.length > MAX_MESSAGES)
			this.messages.splice(0, this.messages.length - MAX_MESSAGES)
	}
}
