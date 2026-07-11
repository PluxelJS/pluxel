import { BasePlugin, Plugin } from '@pluxel/runtime'
import {
	conversationKey,
	type ChatContent,
	type ChatMessage,
	type ChatSendResult,
	type ChatTransport,
} from '@repo/chatbots-contracts'

export type ChatHandlerResult = void | 'stop'

export type ChatHandlerContext = {
	message: ChatMessage
	signal: AbortSignal
	reply(content: ChatContent): Promise<ChatSendResult>
}

export type ChatHandler = (
	context: ChatHandlerContext,
) => ChatHandlerResult | Promise<ChatHandlerResult>

export type ChatHandlerSpec = {
	id: string
	handle: ChatHandler
	/** Lower values run first. @default 100 */
	priority?: number
}

export type ChatHubLogger = {
	debug(message: string, data?: Record<string, unknown>): void
	warn(message: string, data?: Record<string, unknown>): void
}

const nullLogger: ChatHubLogger = { debug() {}, warn() {} }

/** Transport-neutral router. It serializes each conversation while allowing unrelated chats in parallel. */
export class ChatRouter {
	private readonly transports = new Map<string, ChatTransport>()
	private readonly handlers = new Map<
		string,
		Required<Pick<ChatHandlerSpec, 'id' | 'priority'>> & Pick<ChatHandlerSpec, 'handle'>
	>()
	private readonly tails = new Map<string, Promise<void>>()
	private readonly recent = new Map<string, number>()

	constructor(
		private readonly logger: ChatHubLogger = nullLogger,
		private readonly dedupeLimit = 10_000,
	) {}

	registerTransport(transport: ChatTransport): () => void {
		if (this.transports.has(transport.name))
			throw new Error(`Chat transport already registered: ${transport.name}`)
		this.transports.set(transport.name, transport)
		return () => {
			if (this.transports.get(transport.name) === transport) this.transports.delete(transport.name)
		}
	}

	registerHandler(spec: ChatHandlerSpec): () => void {
		if (this.handlers.has(spec.id)) throw new Error(`Chat handler already registered: ${spec.id}`)
		const registered = { id: spec.id, priority: spec.priority ?? 100, handle: spec.handle }
		this.handlers.set(spec.id, registered)
		return () => {
			if (this.handlers.get(spec.id) === registered) this.handlers.delete(spec.id)
		}
	}

	listTransports(): string[] {
		return [...this.transports.keys()].sort()
	}

	listHandlers(): Array<{ id: string; priority: number }> {
		return [...this.handlers.values()]
			.map(({ id, priority }) => ({ id, priority }))
			.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
	}

	receive(message: ChatMessage, signal = new AbortController().signal): Promise<void> {
		const unique = `${message.transport}:${message.conversation.id}:${message.id}`
		if (this.recent.has(unique)) return Promise.resolve()
		this.recent.set(unique, Date.now())
		if (this.recent.size > this.dedupeLimit) this.recent.delete(this.recent.keys().next().value!)

		const key = conversationKey(message)
		const previous = this.tails.get(key) ?? Promise.resolve()
		const current = previous.catch((): void => undefined).then(() => this.dispatch(message, signal))
		this.tails.set(key, current)
		const cleanup = () => {
			if (this.tails.get(key) === current) this.tails.delete(key)
		}
		void current.then(cleanup, cleanup)
		return current
	}

	async send(
		transportName: string,
		conversationId: string,
		content: ChatContent,
		signal?: AbortSignal,
	): Promise<ChatSendResult> {
		const transport = this.transports.get(transportName)
		if (!transport) throw new Error(`Chat transport is not available: ${transportName}`)
		return transport.send({ conversationId, content }, signal)
	}

	private async dispatch(message: ChatMessage, signal: AbortSignal): Promise<void> {
		const transport = this.transports.get(message.transport)
		if (!transport)
			throw new Error(`Inbound message uses an unregistered transport: ${message.transport}`)
		const handlers = [...this.handlers.values()].sort(
			(a, b) => a.priority - b.priority || a.id.localeCompare(b.id),
		)
		for (const handler of handlers) {
			if (signal.aborted) return
			try {
				const result = await handler.handle({
					message,
					signal,
					reply: (content) =>
						transport.send(
							{ conversationId: message.conversation.id, content, replyToId: message.id },
							signal,
						),
				})
				if (result === 'stop') return
			} catch (error) {
				this.logger.warn('Chat handler failed', {
					handler: handler.id,
					messageId: message.id,
					error,
				})
			}
		}
		this.logger.debug('Chat message dispatched', {
			messageId: message.id,
			handlers: handlers.length,
		})
	}
}

@Plugin({ name: 'ChatHubPlugin' })
export class ChatHubPlugin extends BasePlugin {
	private router!: ChatRouter

	override init(): void {
		this.router = new ChatRouter(this.ctx.logger)
	}

	registerTransport(transport: ChatTransport): () => void {
		return this.ready().registerTransport(transport)
	}
	registerHandler(spec: ChatHandlerSpec): () => void {
		return this.ready().registerHandler(spec)
	}
	receive(message: ChatMessage, signal?: AbortSignal): Promise<void> {
		return this.ready().receive(message, signal)
	}
	send(
		transport: string,
		conversationId: string,
		content: ChatContent,
		signal?: AbortSignal,
	): Promise<ChatSendResult> {
		return this.ready().send(transport, conversationId, content, signal)
	}
	listTransports(): string[] {
		return this.ready().listTransports()
	}
	listHandlers(): Array<{ id: string; priority: number }> {
		return this.ready().listHandlers()
	}

	private ready(): ChatRouter {
		if (!this.router) throw new Error('ChatHubPlugin is not running')
		return this.router
	}
}

export * from '@repo/chatbots-contracts'
