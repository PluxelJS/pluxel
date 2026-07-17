import {
	addressKey,
	conversationKey,
	isChatBatch,
	messageKey,
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
	maxPendingReceives?: number
	maxPendingReceivesPerConversation?: number
	maxPendingSends?: number
	maxPendingSendsPerConversation?: number
	drainTimeoutMs?: number
	now?: () => number
}

type RegisteredHandler = Required<Pick<ChatHandlerSpec, 'id' | 'priority'>> &
	Pick<ChatHandlerSpec, 'handle'>
type RegisteredObserver = readonly [id: string, observer: ChatObserver]
type SerialLane = { tail: Promise<void>; pending: number }
type RecentMessage = { seenAt: number; task?: Promise<void> }

/** Per-conversation serial router; unrelated conversations remain concurrent. */
export class ChatRouter {
	private readonly transports = new Map<string, ChatTransport>()
	private readonly handlers = new Map<string, RegisteredHandler>()
	private readonly observers = new Map<string, ChatObserver>()
	private readonly receiveLanes = new Map<string, SerialLane>()
	private readonly sendLanes = new Map<string, SerialLane>()
	private readonly sendTasks = new Set<Promise<ChatSendResult>>()
	private readonly recent = new Map<string, RecentMessage>()
	private readonly lifecycle = new AbortController()
	private handlerPlan?: readonly RegisteredHandler[]
	private observerPlan?: readonly RegisteredObserver[]
	private closed = false
	private closeTask?: Promise<void>
	private readonly dedupeLimit: number
	private readonly dedupeWindowMs: number
	private readonly maxPendingReceives: number
	private readonly maxPendingReceivesPerConversation: number
	private readonly maxPendingSends: number
	private readonly maxPendingSendsPerConversation: number
	private readonly drainTimeoutMs: number
	private readonly now: () => number
	private pendingReceives = 0
	private pendingSends = 0
	private runningSends = 0
	private readonly counters = {
		received: 0,
		deduplicated: 0,
		rejectedReceives: 0,
		handled: 0,
		failedHandlers: 0,
		failedObservers: 0,
		sent: 0,
		failedSends: 0,
		rejectedSends: 0,
		drainTimeouts: 0,
	}

	constructor(
		private readonly logger: ChatHubLogger = nullLogger,
		options: ChatRouterOptions = {},
	) {
		this.dedupeLimit = options.dedupeLimit ?? 10_000
		this.dedupeWindowMs = options.dedupeWindowMs ?? 5 * 60_000
		this.maxPendingReceives = options.maxPendingReceives ?? 4_096
		this.maxPendingReceivesPerConversation = options.maxPendingReceivesPerConversation ?? 256
		this.maxPendingSends = options.maxPendingSends ?? 4_096
		this.maxPendingSendsPerConversation = options.maxPendingSendsPerConversation ?? 256
		this.drainTimeoutMs = options.drainTimeoutMs ?? 30_000
		this.now = options.now ?? Date.now
		if (!Number.isInteger(this.dedupeLimit) || this.dedupeLimit < 1)
			throw new Error('Chat router dedupeLimit must be a positive integer')
		if (!Number.isFinite(this.dedupeWindowMs) || this.dedupeWindowMs < 0)
			throw new Error('Chat router dedupeWindowMs must be non-negative')
		for (const [name, value] of [
			['maxPendingReceives', this.maxPendingReceives],
			['maxPendingReceivesPerConversation', this.maxPendingReceivesPerConversation],
			['maxPendingSends', this.maxPendingSends],
			['maxPendingSendsPerConversation', this.maxPendingSendsPerConversation],
		] as const)
			if (!Number.isInteger(value) || value < 1)
				throw new Error(`Chat router ${name} must be a positive integer`)
		if (!Number.isFinite(this.drainTimeoutMs) || this.drainTimeoutMs < 1)
			throw new Error('Chat router drainTimeoutMs must be positive')
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
			activeConversations: this.receiveLanes.size,
			pendingReceives: this.pendingReceives,
			outboundConversations: this.sendLanes.size,
			pendingSends: this.pendingSends,
			runningSends: this.runningSends,
			...this.counters,
		}
	}

	receive(message: ChatMessage, signal?: AbortSignal): Promise<void> {
		if (this.closed) return Promise.reject(new Error('Chat router is closed'))
		this.counters.received++
		const conversation = conversationKey(message)
		const unique = messageKey(message)
		const now = this.now()
		const recent = this.recent.get(unique)
		if (recent && (recent.task || now - recent.seenAt <= this.dedupeWindowMs)) {
			this.counters.deduplicated++
			return recent.task ?? Promise.resolve()
		}
		if (recent) this.recent.delete(unique)
		const existingLane = this.receiveLanes.get(conversation)
		if (
			this.pendingReceives >= this.maxPendingReceives ||
			(existingLane && existingLane.pending >= this.maxPendingReceivesPerConversation)
		) {
			this.counters.rejectedReceives++
			return Promise.reject(new Error(`Chat receive queue is full: ${formatMessage(message)}`))
		}
		this.pruneRecent(now)
		const lane = existingLane ?? { tail: Promise.resolve(), pending: 0 }
		lane.pending++
		this.pendingReceives++
		const dispatchSignal = signal
			? AbortSignal.any([signal, this.lifecycle.signal])
			: this.lifecycle.signal
		const current = lane.tail
			.catch((): void => undefined)
			.then(() => this.dispatch(message, dispatchSignal))
		const entry: RecentMessage = { seenAt: now, task: current }
		this.recent.set(unique, entry)
		this.pruneRecentLimit()
		lane.tail = settle(current)
		this.receiveLanes.set(conversation, lane)
		const cleanup = () => {
			lane.pending--
			this.pendingReceives--
			if (lane.pending === 0 && this.receiveLanes.get(conversation) === lane)
				this.receiveLanes.delete(conversation)
		}
		void lane.tail.then(cleanup)
		void current.then(
			(): void => {
				if (this.recent.get(unique) === entry) entry.task = undefined
				return undefined
			},
			(): void => {
				if (this.recent.get(unique) === entry) this.recent.delete(unique)
				return undefined
			},
		)
		return current
	}

	/** Stops new work, aborts active dispatches, and drains every conversation queue. */
	close(): Promise<void> {
		return (this.closeTask ??= this.closeAndDrain())
	}

	private async closeAndDrain(): Promise<void> {
		this.closed = true
		this.lifecycle.abort(new Error('Chat router is closed'))
		await this.drain([
			...Array.from(this.receiveLanes.values(), (lane) => lane.tail),
			...this.sendTasks,
		])
		this.transports.clear()
		this.handlers.clear()
		this.observers.clear()
		this.recent.clear()
		this.receiveLanes.clear()
		this.sendLanes.clear()
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
		const key = addressKey(address)
		const existingLane = this.sendLanes.get(key)
		if (
			this.pendingSends >= this.maxPendingSends ||
			(existingLane && existingLane.pending >= this.maxPendingSendsPerConversation)
		) {
			this.counters.rejectedSends++
			return Promise.reject(new Error(`Chat send queue is full: ${formatAddress(address)}`))
		}
		const lane = existingLane ?? { tail: Promise.resolve(), pending: 0 }
		lane.pending++
		this.pendingSends++
		const sendSignal = signal
			? AbortSignal.any([signal, this.lifecycle.signal])
			: this.lifecycle.signal
		const task = lane.tail.then(async () => {
			if (sendSignal.aborted) throw sendSignal.reason
			this.runningSends++
			try {
				return await this.sendBatch(address, content, sendSignal, options)
			} finally {
				this.runningSends--
			}
		})
		lane.tail = settle(task)
		this.sendLanes.set(key, lane)
		this.sendTasks.add(task)
		void lane.tail.then((): void => {
			lane.pending--
			this.pendingSends--
			this.sendTasks.delete(task)
			if (lane.pending === 0 && this.sendLanes.get(key) === lane) this.sendLanes.delete(key)
			return undefined
		})
		return observeAbort(task, sendSignal)
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
				if (!signal.aborted) this.counters.failedSends++
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
		if (signal.aborted) throw signal.reason
		if (!this.transports.has(transportKey(message)))
			throw new Error(`Inbound message uses an unregistered transport: ${formatTransport(message)}`)
		const observerTasks = this.getObserverPlan().map(async ([id, observer]) => {
			try {
				await observer(message, signal)
			} catch (error) {
				if (!signal.aborted) {
					this.counters.failedObservers++
					this.logger.warn('Chat observer failed', { observer: id, messageId: message.id, error })
				}
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
				if (!signal.aborted) {
					this.counters.failedHandlers++
					this.logger.warn('Chat handler failed', {
						handler: handler.id,
						messageId: message.id,
						error,
					})
				}
			}
		}
		await Promise.all(observerTasks)
		if (signal.aborted) throw signal.reason
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
		for (const [key, entry] of this.recent) {
			if (entry.task) continue
			if (now - entry.seenAt <= this.dedupeWindowMs) break
			this.recent.delete(key)
		}
	}

	private pruneRecentLimit(): void {
		if (this.recent.size <= this.dedupeLimit) return
		for (const [key, entry] of this.recent) {
			if (!entry.task) this.recent.delete(key)
			if (this.recent.size <= this.dedupeLimit) return
		}
	}

	private async drain(tasks: readonly Promise<unknown>[]): Promise<void> {
		if (tasks.length === 0) return
		const drained = Promise.allSettled(tasks)
		let timer: ReturnType<typeof setTimeout> | undefined
		const timedOut = new Promise<'timeout'>((resolve) => {
			timer = setTimeout(() => resolve('timeout'), this.drainTimeoutMs)
		})
		const result = await Promise.race([drained.then(() => 'drained' as const), timedOut])
		if (timer) clearTimeout(timer)
		if (result === 'timeout') {
			this.counters.drainTimeouts++
			this.logger.warn('Chat router drain timed out', {
				timeoutMs: this.drainTimeoutMs,
				pendingReceives: this.pendingReceives,
				pendingSends: this.pendingSends,
			})
		}
	}

	private assertOpen(): void {
		if (this.closed) throw new Error('Chat router is closed')
	}
}

function formatTransport(ref: { platform: string; accountId: string }): string {
	return `${ref.platform}/${ref.accountId}`
}

function formatAddress(address: ChatAddress): string {
	return `${formatTransport(address)}/${address.conversationId}`
}

function formatMessage(message: ChatMessage): string {
	return formatAddress({
		platform: message.platform,
		accountId: message.accountId,
		conversationId: message.conversation.id,
	})
}

function settle(task: Promise<unknown>): Promise<void> {
	return task.then(
		(): void => undefined,
		(): void => undefined,
	)
}

function observeAbort<Value>(task: Promise<Value>, signal: AbortSignal): Promise<Value> {
	if (signal.aborted) return Promise.reject(signal.reason)
	return new Promise((resolve, reject) => {
		const abort = () => reject(signal.reason)
		signal.addEventListener('abort', abort, { once: true })
		void task.then(
			(value): void => {
				signal.removeEventListener('abort', abort)
				resolve(value)
				return undefined
			},
			(error): void => {
				signal.removeEventListener('abort', abort)
				reject(error)
				return undefined
			},
		)
	})
}
