import {
	conversationKey,
	isChatBatch,
	transportKey,
	type ChatAddress,
	type ChatDeliveryMode,
	type ChatMessage,
	type ChatPayload,
	type ChatSendResult,
	type ChatTransport,
} from '@repo/chatbots-contracts'
import { planChatDelivery } from './delivery.ts'
import type { ChatHandlerSpec, ChatHubLogger, ChatObserver, ChatRouterSnapshot } from './handler.ts'

const nullLogger: ChatHubLogger = { debug() {}, warn() {} }

export type ChatRouterOptions = {
	dedupeLimit?: number
	dedupeWindowMs?: number
	now?: () => number
}

type RegisteredHandler = Required<Pick<ChatHandlerSpec, 'id' | 'priority'>> &
	Pick<ChatHandlerSpec, 'handle'>
type RegisteredObserver = readonly [id: string, observer: ChatObserver]

/** Per-conversation serial router; unrelated conversations remain concurrent. */
export class ChatRouter {
	private readonly transports = new Map<string, ChatTransport>()
	private readonly handlers = new Map<string, RegisteredHandler>()
	private readonly observers = new Map<string, ChatObserver>()
	private readonly tails = new Map<string, Promise<void>>()
	private readonly activeSends = new Set<Promise<ChatSendResult>>()
	private readonly recent = new Map<string, number>()
	private readonly lifecycle = new AbortController()
	private handlerPlan?: readonly RegisteredHandler[]
	private observerPlan?: readonly RegisteredObserver[]
	private closed = false
	private closeTask?: Promise<void>
	private readonly dedupeLimit: number
	private readonly dedupeWindowMs: number
	private readonly now: () => number
	private readonly counters = {
		received: 0,
		deduplicated: 0,
		handled: 0,
		failedHandlers: 0,
		sent: 0,
	}

	constructor(
		private readonly logger: ChatHubLogger = nullLogger,
		options: ChatRouterOptions = {},
	) {
		this.dedupeLimit = options.dedupeLimit ?? 10_000
		this.dedupeWindowMs = options.dedupeWindowMs ?? 5 * 60_000
		this.now = options.now ?? Date.now
		if (!Number.isInteger(this.dedupeLimit) || this.dedupeLimit < 1)
			throw new Error('Chat router dedupeLimit must be a positive integer')
		if (!Number.isFinite(this.dedupeWindowMs) || this.dedupeWindowMs < 0)
			throw new Error('Chat router dedupeWindowMs must be non-negative')
	}

	registerTransport(transport: ChatTransport): () => void {
		this.assertOpen()
		if (!transport.platform.trim() || !transport.accountId.trim())
			throw new Error('Chat transport platform and accountId must be non-empty')
		const key = transportKey(transport)
		if (this.transports.has(key))
			throw new Error(`Chat transport already registered: ${formatTransport(transport)}`)
		this.transports.set(key, transport)
		return () => {
			if (this.transports.get(key) === transport) this.transports.delete(key)
		}
	}

	registerHandler(spec: ChatHandlerSpec): () => void {
		this.assertOpen()
		if (this.handlers.has(spec.id)) throw new Error(`Chat handler already registered: ${spec.id}`)
		const registered = { id: spec.id, priority: spec.priority ?? 100, handle: spec.handle }
		this.handlers.set(spec.id, registered)
		this.handlerPlan = undefined
		return () => {
			if (this.handlers.get(spec.id) === registered) {
				this.handlers.delete(spec.id)
				this.handlerPlan = undefined
			}
		}
	}

	registerObserver(id: string, observer: ChatObserver): () => void {
		this.assertOpen()
		if (this.observers.has(id)) throw new Error(`Chat observer already registered: ${id}`)
		this.observers.set(id, observer)
		this.observerPlan = undefined
		return () => {
			if (this.observers.get(id) === observer) {
				this.observers.delete(id)
				this.observerPlan = undefined
			}
		}
	}

	listTransports(): Array<{ platform: string; accountId: string }> {
		return [...this.transports.values()]
			.map(({ platform, accountId }) => ({ platform, accountId }))
			.sort(
				(a, b) => a.platform.localeCompare(b.platform) || a.accountId.localeCompare(b.accountId),
			)
	}
	listHandlers(): Array<{ id: string; priority: number }> {
		return this.getHandlerPlan().map(({ id, priority }) => ({ id, priority }))
	}
	snapshot(): ChatRouterSnapshot {
		return {
			transports: this.listTransports(),
			handlers: this.listHandlers(),
			observers: [...this.observers.keys()].sort(),
			activeConversations: this.tails.size,
			...this.counters,
		}
	}

	receive(message: ChatMessage, signal?: AbortSignal): Promise<void> {
		if (this.closed) return Promise.reject(new Error('Chat router is closed'))
		this.counters.received++
		const conversation = conversationKey(message)
		const unique = `${conversation}${message.id.length}:${message.id}`
		const now = this.now()
		const seenAt = this.recent.get(unique)
		if (seenAt !== undefined && now - seenAt <= this.dedupeWindowMs) {
			this.counters.deduplicated++
			return Promise.resolve()
		}
		if (seenAt !== undefined) this.recent.delete(unique)
		this.pruneRecent(now)
		this.recent.set(unique, now)
		if (this.recent.size > this.dedupeLimit) this.recent.delete(this.recent.keys().next().value!)
		const previous = this.tails.get(conversation) ?? Promise.resolve()
		const dispatchSignal = signal
			? AbortSignal.any([signal, this.lifecycle.signal])
			: this.lifecycle.signal
		const current = previous
			.catch((): void => undefined)
			.then(() => this.dispatch(message, dispatchSignal))
		this.tails.set(conversation, current)
		const cleanup = () => {
			if (this.tails.get(conversation) === current) this.tails.delete(conversation)
		}
		void current.then(cleanup, cleanup)
		return current
	}

	/** Stops new work, aborts active dispatches, and drains every conversation queue. */
	close(): Promise<void> {
		return (this.closeTask ??= this.closeAndDrain())
	}

	private async closeAndDrain(): Promise<void> {
		this.closed = true
		this.lifecycle.abort(new Error('Chat router is closed'))
		await Promise.allSettled([...this.tails.values(), ...this.activeSends])
		this.transports.clear()
		this.handlers.clear()
		this.observers.clear()
		this.recent.clear()
		this.handlerPlan = undefined
		this.observerPlan = undefined
	}

	async send(
		address: ChatAddress,
		content: ChatPayload,
		signal?: AbortSignal,
		options: { replyToId?: string; mode?: ChatDeliveryMode } = {},
	): Promise<ChatSendResult> {
		this.assertOpen()
		const sendSignal = signal
			? AbortSignal.any([signal, this.lifecycle.signal])
			: this.lifecycle.signal
		const task = this.sendBatch(address, content, sendSignal, options)
		this.activeSends.add(task)
		try {
			return await task
		} finally {
			this.activeSends.delete(task)
		}
	}

	private async sendBatch(
		address: ChatAddress,
		content: ChatPayload,
		signal: AbortSignal,
		options: { replyToId?: string; mode?: ChatDeliveryMode },
	): Promise<ChatSendResult> {
		const messages = isChatBatch(content) ? content.messages : [content]
		const strategy = isChatBatch(content) ? content.strategy : 'fail-fast'
		if (messages.length === 0) throw new Error('Chat batch requires at least one message')
		const ids: string[] = []
		const failures: Array<{ index: number; message: string }> = []
		for (let index = 0; index < messages.length; index++) {
			try {
				ids.push(
					...(await this.sendContent(address, messages[index]!, signal, {
						...options,
						replyToId: index === 0 ? options.replyToId : undefined,
					})),
				)
			} catch (error) {
				if (strategy === 'fail-fast') throw error
				failures.push({ index, message: error instanceof Error ? error.message : String(error) })
			}
		}
		if (ids.length === 0 && failures.length > 0)
			throw new AggregateError(
				failures.map((failure) => new Error(failure.message)),
				'Every chat batch item failed',
			)
		return {
			messageId: ids.at(-1)!,
			...(ids.length > 1 ? { messageIds: ids } : {}),
			...(failures.length > 0 ? { failures } : {}),
		}
	}

	private async sendContent(
		address: ChatAddress,
		content: Exclude<ChatPayload, { kind: 'chat-batch' }>,
		signal: AbortSignal | undefined,
		options: { replyToId?: string; mode?: ChatDeliveryMode },
	): Promise<string[]> {
		const transport = this.transports.get(transportKey(address))
		if (!transport) throw new Error(`Chat transport is not available: ${formatTransport(address)}`)
		const requests = planChatDelivery(transport, {
			conversationId: address.conversationId,
			content,
			...options,
		})
		const ids: string[] = []
		for (const request of requests) {
			if (signal?.aborted) throw signal.reason
			const result = await transport.send(request, signal)
			ids.push(...(result.messageIds ?? [result.messageId]))
			this.counters.sent++
		}
		return ids
	}

	private async dispatch(message: ChatMessage, signal: AbortSignal): Promise<void> {
		if (signal.aborted) return
		if (!this.transports.has(transportKey(message)))
			throw new Error(`Inbound message uses an unregistered transport: ${formatTransport(message)}`)
		const observerTasks = this.getObserverPlan().map(async ([id, observer]) => {
			try {
				await observer(message, signal)
			} catch (error) {
				this.logger.warn('Chat observer failed', { observer: id, messageId: message.id, error })
			}
		})
		const handlers = this.getHandlerPlan()
		for (const handler of handlers) {
			if (signal.aborted) break
			try {
				const result = await handler.handle({
					message,
					signal,
					reply: (content, options) =>
						this.send(
							{
								platform: message.platform,
								accountId: message.accountId,
								conversationId: message.conversation.id,
							},
							content,
							signal,
							{
								replyToId: message.id,
								...options,
							},
						),
					send: (conversationId, content, options) =>
						this.send(
							{ platform: message.platform, accountId: message.accountId, conversationId },
							content,
							signal,
							options,
						),
				})
				if (result === 'stop') {
					this.counters.handled++
					break
				}
			} catch (error) {
				this.counters.failedHandlers++
				this.logger.warn('Chat handler failed', {
					handler: handler.id,
					messageId: message.id,
					error,
				})
			}
		}
		await Promise.all(observerTasks)
		this.logger.debug('Chat message dispatched', {
			messageId: message.id,
			handlers: handlers.length,
		})
	}

	private getHandlerPlan(): readonly RegisteredHandler[] {
		return (this.handlerPlan ??= [...this.handlers.values()].sort(
			(a, b) => a.priority - b.priority || a.id.localeCompare(b.id),
		))
	}

	private getObserverPlan(): readonly RegisteredObserver[] {
		return (this.observerPlan ??= [...this.observers.entries()])
	}

	private pruneRecent(now: number): void {
		for (const [key, seenAt] of this.recent) {
			if (now - seenAt <= this.dedupeWindowMs) break
			this.recent.delete(key)
		}
	}

	private assertOpen(): void {
		if (this.closed) throw new Error('Chat router is closed')
	}
}

function formatTransport(ref: { platform: string; accountId: string }): string {
	return `${ref.platform}/${ref.accountId}`
}
