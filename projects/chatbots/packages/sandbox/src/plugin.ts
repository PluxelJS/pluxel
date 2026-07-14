import { BasePlugin, Plugin } from '@pluxel/runtime'
import { workbench, type MountedWorkbenchManagedCollections } from '@pluxel/runtime/workbench'
import { contentText, normalizeContent, type ChatSendRequest } from '@repo/chatbots-contracts'
import { KeyedSerialExecutor } from '@repo/chatbots-adapter-kit/keyed-serial'
import { ChatHubPlugin } from '@repo/chatbots-hub'
import { ChatSandboxRpc } from './rpc.ts'
import type { SandboxInput, SandboxMessage } from './workbench-contract.ts'
import { ChatSandboxWorkbench } from './workbench-extension.ts'

const MAX_MESSAGES = 500

@Plugin({ name: 'ChatSandboxPlugin' })
export class ChatSandboxPlugin extends BasePlugin {
	private messages: SandboxMessage[] = []
	private sequence = 1
	private projection?: MountedWorkbenchManagedCollections<typeof ChatSandboxWorkbench>['messages']
	private readonly accepts = new KeyedSerialExecutor<string>()

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
		const mounted = this.ctx.workbench.mount(ChatSandboxWorkbench, {
			commands: workbench.bind.rpc(() => new ChatSandboxRpc(this)),
			messages: workbench.bind.managedCollection(),
		})
		if (mounted) {
			this.projection = mounted.managedCollections.messages
			await this.projection.ready()
			this.projection.removeMany({})
		}
		this.ctx.http.plugin.routes(
			(app) =>
				app
					.get('/status', () => ({
						ok: true,
						messages: this.messages.length,
						transports: this.hub.listTransports(),
						handlers: this.hub.listHandlers(),
						router: this.hub.snapshot(),
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
		return this.accepts.run(conversationId, () => this.acceptSerial(input, conversationId))
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
		this.project(() =>
			this.projection?.replaceOne({ id: message.id }, structuredClone(message), { upsert: true }),
		)
		if (this.messages.length > MAX_MESSAGES)
			for (const removed of this.messages.splice(0, this.messages.length - MAX_MESSAGES))
				this.project(() => this.projection?.removeOne({ id: removed.id }))
	}

	reset(): { ok: true } {
		this.messages = []
		this.sequence = 1
		this.project(() => this.projection?.removeMany({}))
		return { ok: true }
	}
	status() {
		return { ...this.hub.snapshot(), messages: this.messages.length }
	}

	private project(operation: () => unknown): void {
		try {
			operation()
		} catch (error) {
			this.ctx.logger.warn('Failed to update chat sandbox workbench projection', { error })
		}
	}
}
