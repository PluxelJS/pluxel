import '@pluxel/runtime/register/static'
import { BasePlugin, Plugin } from '@pluxel/runtime'
import { ui, type ManagementStateCollection } from '@pluxel/runtime/web-management'
import type { ExtensionUiRpcMap as _ExtensionUiRpcMap } from '@pluxel/runtime/web'
import {
	ChatHubPlugin,
	contentText,
	normalizeContent,
	type ChatBlock,
	type ChatMessage,
	type ChatSendRequest,
} from '@repo/chatbots-hub'
import { ChatSandboxRpc } from './rpc.ts'

export type SandboxMessage = ChatMessage & { direction: 'inbound' | 'outbound' }

export type SandboxInput = {
	text?: string
	content?: ChatBlock[]
	conversationId?: string
	actorId?: string
	displayName?: string
}

const MAX_MESSAGES = 500
const pluginUi = ui(import.meta.url, './ui/index.tsx')

@Plugin({ name: 'ChatSandboxPlugin' })
export class ChatSandboxPlugin extends BasePlugin {
	private messages: SandboxMessage[] = []
	private sequence = 1
	private projection?: ManagementStateCollection<SandboxMessage>
	private readonly acceptTails = new Map<string, Promise<unknown>>()

	constructor(private readonly hub: ChatHubPlugin) {
		super()
	}

	override async init(): Promise<void> {
		const dispose = this.hub.registerTransport({
			platform: 'sandbox',
			accountId: 'default',
			capabilities: {
				blocks: ['text', 'mention', 'link', 'code', 'image', 'audio', 'video', 'file'],
				mixedContent: true,
			},
			send: async (request) => this.captureOutbound(request),
		})
		this.ctx.effects.defer(dispose)
		await this.ctx.webManagement.use(async (web) => {
			this.projection = web.state.collection<SandboxMessage>({ name: 'messages' })
			await this.projection.ready()
			web.ui.register(pluginUi)
			web.rpc.expose(() => new ChatSandboxRpc(this))
		})
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
					.post('/reset', () => this.reset()),
			{ path: '/api', id: 'ChatSandboxPlugin:api' },
		)
	}

	accept(input: SandboxInput): Promise<{ message: SandboxMessage; replies: SandboxMessage[] }> {
		const conversationId = input.conversationId ?? 'default'
		const previous = this.acceptTails.get(conversationId) ?? Promise.resolve()
		const current = previous
			.catch((): void => undefined)
			.then(() => this.acceptSerial(input, conversationId))
		this.acceptTails.set(conversationId, current)
		const cleanup = () => {
			if (this.acceptTails.get(conversationId) === current) this.acceptTails.delete(conversationId)
		}
		void current.then(cleanup, cleanup)
		return current
	}

	private async acceptSerial(
		input: SandboxInput,
		conversationId: string,
	): Promise<{ message: SandboxMessage; replies: SandboxMessage[] }> {
		const blocks = input.content?.length
			? normalizeContent(input.content)
			: normalizeContent(input.text ?? '')
		if (blocks.length === 0 || !contentText(blocks))
			throw new Error('A non-empty text or content field is required')
		const message: SandboxMessage = {
			id: `in-${this.sequence++}`,
			direction: 'inbound',
			platform: 'sandbox',
			accountId: 'default',
			conversation: { id: conversationId, kind: 'direct', title: 'Sandbox' },
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
			replies: this.messages
				.slice(before)
				.filter((item) => item.direction === 'outbound' && item.conversation.id === conversationId),
		}
	}

	private async captureOutbound(request: ChatSendRequest) {
		const blocks = normalizeContent(request.content)
		const message: SandboxMessage = {
			id: `out-${this.sequence++}`,
			direction: 'outbound',
			platform: 'sandbox',
			accountId: 'default',
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
		this.projection?.insert(structuredClone(message))
		if (this.messages.length > MAX_MESSAGES)
			for (const removed of this.messages.splice(0, this.messages.length - MAX_MESSAGES))
				this.projection?.removeOne({ id: removed.id })
	}

	reset(): { ok: true } {
		this.messages = []
		this.sequence = 1
		this.projection?.removeMany({})
		return { ok: true }
	}
	status() {
		return { ...this.hub.snapshot(), messages: this.messages.length }
	}
}

declare module '@pluxel/runtime/web' {
	interface ExtensionUiRpcMap {
		ChatSandboxPlugin: ChatSandboxRpc
	}
	interface ExtensionUiSignalDbMap {
		ChatSandboxPlugin: { messages: SandboxMessage }
	}
}
