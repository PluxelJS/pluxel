import { BasePlugin, Plugin } from '@pluxel/runtime'
import type {
	ChatAddress,
	ChatDeliveryMode,
	ChatMessage,
	ChatPayload,
	ChatSendResult,
	ChatTransport,
} from '@repo/chatbots-contracts'
import type { ChatHandlerSpec, ChatObserver, ChatRouterSnapshot } from './handler.ts'
import { ChatMatcherIndex, type ChatMatcherSpec } from './matcher/index.ts'
import { ChatRouter } from './router.ts'

@Plugin({ name: 'ChatHubPlugin' })
export class ChatHubPlugin extends BasePlugin {
	private router!: ChatRouter
	private readonly matchers = new ChatMatcherIndex()
	override init(): void {
		this.router = new ChatRouter(this.ctx.logger)
		this.ctx.effects.defer(() => this.router.close())
		this.ctx.effects.defer(
			this.router.registerHandler({
				id: 'chatbots.matchers',
				priority: 50,
				handle: (context) =>
					this.matchers.dispatch(context, (matcher, error) =>
						this.ctx.logger.warn('Chat observe matcher failed', { matcher, error }),
					),
			}),
		)
	}
	registerTransport(transport: ChatTransport): () => void {
		return this.ready().registerTransport(transport)
	}
	registerHandler(spec: ChatHandlerSpec): () => void {
		return this.ready().registerHandler(spec)
	}
	registerObserver(id: string, observer: ChatObserver): () => void {
		return this.ready().registerObserver(id, observer)
	}
	registerMatcher<T>(spec: ChatMatcherSpec<T>): () => void {
		return this.matchers.register(spec)
	}
	receive(message: ChatMessage, signal?: AbortSignal): Promise<void> {
		return this.ready().receive(message, signal)
	}
	send(
		address: ChatAddress,
		content: ChatPayload,
		signal?: AbortSignal,
		options?: { replyToId?: string; mode?: ChatDeliveryMode },
	): Promise<ChatSendResult> {
		return this.ready().send(address, content, signal, options)
	}
	listTransports(): Array<{ platform: string; accountId: string }> {
		return this.ready().listTransports()
	}
	listHandlers(): Array<{ id: string; priority: number }> {
		return this.ready().listHandlers()
	}
	snapshot(): ChatRouterSnapshot {
		return this.ready().snapshot()
	}
	private ready(): ChatRouter {
		if (!this.router) throw new Error('ChatHubPlugin is not running')
		return this.router
	}
}
