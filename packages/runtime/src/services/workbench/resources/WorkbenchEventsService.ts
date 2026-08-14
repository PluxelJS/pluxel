import type { Context } from '@pluxel/core'
import { createResponse, type Session } from 'better-sse'
import type { InferContext } from 'elysia'

import { createElysiaApp } from '../../http/elysia'

type SseHttpContext = InferContext<ReturnType<typeof createElysiaApp>>

export interface SseEventPayload {
	event?: string
	data?: unknown
	id?: string
	retry?: number
	comment?: string
	raw?: boolean
}

export type SsePayload =
	| SseEventPayload
	| Record<string, unknown>
	| string
	| number
	| boolean
	| bigint
	| null

export interface SseChannel {
	/** 当前命名空间（默认等于插件名） */
	namespace: string
	/** 请求对应的 URLSearchParams，便于按需过滤 */
	query: URLSearchParams
	/** Current HTTP request context. */
	http: SseHttpContext
	/** 插件上下文（动态回灌） */
	ctx: Context
	/** 主动推送事件；默认 event=namespace，data 自动 JSON 化 */
	send(payload: SsePayload): void
	/** 指定 event 名推送（避免手写 event 字段） */
	emit(event: string, data?: unknown, extras?: Omit<SseEventPayload, 'data' | 'event'>): void
	/** 客户端断开/取消时触发 */
	onAbort(cb: () => void): void
	/** 是否已标记关闭 */
	readonly closed: boolean
}

export type SseHandler = (
	channel: SseChannel,
) => void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>

type RegisteredWorkbenchEvents = {
	owner: Context
	handler: SseHandler
}

type StreamSubscription = {
	/** Public namespace emitted to the browser and unique within the session. */
	key: string
	/** Internal resource namespace used to resolve and rebind the handler. */
	namespace: string
}

type SessionHandler = {
	namespace: string
	cleanup?: () => void | Promise<void>
}

type SessionState = {
	requested: Map<string, string>
	handlers: Map<string, SessionHandler>
	query?: URLSearchParams
	httpCtx?: SseHttpContext
}

export class WorkbenchEventsService {
	private resources = new Map<string, RegisteredWorkbenchEvents>()
	private readonly sessions = new Set<Session<SessionState>>()
	private readonly pendingByNamespace = new Map<string, Map<Session<SessionState>, Set<string>>>()
	private static readonly KEEPALIVE_MS = 25_000
	private static readonly RETRY_MS = 2_000

	constructor(
		public ctx: Context,
		_cfg: unknown,
	) {}

	/** @internal Register against an immutable owner Context. */
	registerResourceFor(owner: Context, namespace: string, handler: SseHandler): () => void {
		if (!namespace) throw new Error('[workbench] stream namespace required')

		const already = this.resources.has(namespace)
		if (already) {
			owner.logger.warn('Workbench stream "{namespace}" already registered, refreshing', {
				namespace,
			})
			this.resources.delete(namespace)
			this.detachNamespace(namespace)
		}

		const registered = { owner, handler }
		this.resources.set(namespace, registered)
		this.rebindNamespace(namespace)
		this.tryAttachPending(namespace)

		const guard = owner.effects.defer(() => {
			if (this.resources.get(namespace) !== registered) return
			this.resources.delete(namespace)
			this.detachNamespace(namespace)
		})
		return () => guard.dispose()
	}

	stream(c: SseHttpContext, namespaces?: string[]): unknown {
		const params = new URL(c.request.url).searchParams
		const requestedRaw = this.normalizeNamespaces(namespaces ?? this.parseNamespaces(params))
		return this.streamSubscriptions(
			c,
			params,
			requestedRaw.map((namespace) => ({ key: namespace, namespace })),
		)
	}

	/** @internal Emit internal namespaces through opaque, request-scoped aliases. */
	streamWithAliases(
		c: SseHttpContext,
		subscriptions: ReadonlyArray<{ alias: string; namespace: string }>,
	): unknown {
		const params = new URL(c.request.url).searchParams
		return this.streamSubscriptions(
			c,
			params,
			subscriptions.map(({ alias, namespace }) => ({ key: alias, namespace })),
		)
	}

	private streamSubscriptions(
		c: SseHttpContext,
		params: URLSearchParams,
		subscriptions: StreamSubscription[],
	): unknown {
		const requested = this.normalizeSubscriptions(subscriptions)
		const missing = requested
			.filter(({ namespace }) => !this.hasResource(namespace))
			.map(({ namespace }) => namespace)

		if (requested.length === 0) {
			return c.status(404, 'No Workbench streams registered')
		}

		if (missing.length > 0) {
			c.pluginCtx.logger.warn('namespaces missing, fallback', { missing })
		}

		return createResponse<SessionState>(
			c.request,
			{
				keepAlive: WorkbenchEventsService.KEEPALIVE_MS,
				retry: WorkbenchEventsService.RETRY_MS,
				serializer: (value) => this.stringify(value),
				state: {
					requested: new Map(requested.map(({ key, namespace }) => [key, namespace] as const)),
					handlers: new Map(),
				},
			},
			(session) => this.attachSession(session, c, params),
		)
	}

	listNamespaces(): string[] {
		return [...this.resources.keys()]
	}

	hasResource(namespace: string): boolean {
		return this.resources.has(namespace)
	}

	private attachSession(
		session: Session<SessionState>,
		httpCtx: SseHttpContext,
		query: URLSearchParams,
	) {
		this.sessions.add(session)
		const clean = () => this.cleanupSession(session)
		session.once('disconnected', clean)

		session.state.httpCtx = httpCtx
		session.state.query = query

		for (const key of session.state.requested.keys()) {
			this.scheduleSubscriptionAttachment(session, key)
		}
	}

	private createChannelBase(
		session: Session<SessionState>,
		httpCtx: SseHttpContext,
		query: URLSearchParams,
		owner: Context,
	): Omit<SseChannel, 'namespace' | 'send' | 'emit'> {
		return {
			query,
			http: httpCtx,
			ctx: owner,
			get closed() {
				return !session.isConnected
			},
			onAbort: (cb) => {
				if (!session.isConnected) {
					cb()
					return
				}
				session.once('disconnected', cb)
			},
		}
	}

	private async attachSubscriptionToSession(session: Session<SessionState>, key: string) {
		const state = session.state
		if (state.handlers.has(key)) return
		const namespace = state.requested.get(key)
		if (!namespace) return
		const registered = this.resources.get(namespace)
		if (!registered) {
			this.markPending(namespace, session, key)
			return
		}

		this.unmarkPending(namespace, session, key)

		const httpCtx = state.httpCtx
		if (!httpCtx) {
			this.ctx.logger.warn('missing HTTP context for session, skip attach')
			return
		}

		const base = this.createChannelBase(
			session,
			httpCtx,
			state.query ?? new URL(session.getRequest().url).searchParams,
			registered.owner,
		)
		const attachment: SessionHandler = { namespace }
		state.handlers.set(key, attachment)
		const channel = this.createChannel(key, session, base)
		const cleanup = await this.runHandler(registered.handler, channel)
		if (
			!session.isConnected ||
			state.handlers.get(key) !== attachment ||
			state.requested.get(key) !== namespace ||
			this.resources.get(namespace) !== registered
		) {
			if (cleanup) this.runCleanup(cleanup, namespace)
			if (state.handlers.get(key) === attachment) state.handlers.delete(key)
			return
		}
		attachment.cleanup = cleanup
	}

	private createChannel(
		namespace: string,
		session: Session<SessionState>,
		base: Omit<SseChannel, 'namespace' | 'send' | 'emit'>,
	): SseChannel {
		const send = (payload: SsePayload) => {
			if (!session.isConnected) return
			const message = this.normalizePayload(namespace, payload)
			if (!message) return
			try {
				const { data, event, id } = message
				session.push(data, event, id)
			} catch (err) {
				this.ctx.logger.warn('push failed', { error: err })
			}
		}

		const emit = (
			event: string,
			data?: unknown,
			extras?: Omit<SseEventPayload, 'data' | 'event'>,
		) => send({ ...extras, event, data })

		return { namespace, ...base, send, emit }
	}

	private normalizePayload(
		namespace: string,
		payload: SsePayload,
	): { data: string; event?: string; id?: string } | null {
		if (payload === undefined) return null
		const structured =
			typeof payload === 'object' && payload !== null && !(payload instanceof Date)
				? (payload as SseEventPayload)
				: undefined
		const { event, data, id, raw } = structured ?? {}
		const eventName = event ?? namespace
		const body = structured ? ('data' in structured ? data : payload) : payload

		return {
			id,
			// Always use the default "message" event so EventSource.onmessage receives it.
			// The logical event name is carried inside the payload instead.
			event: undefined,
			data: raw
				? this.stringify(body)
				: this.stringify({ namespace, event: eventName, payload: body ?? null }),
		}
	}

	private stringify(value: unknown): string {
		if (typeof value === 'string') return value
		if (value === undefined) return ''
		try {
			const json = JSON.stringify(value)
			return json === undefined ? '' : json
		} catch {
			return String(value)
		}
	}

	private async runHandler(
		handler: SseHandler,
		channel: SseChannel,
	): Promise<(() => void) | undefined> {
		try {
			const maybeCleanup = await handler(channel)
			return typeof maybeCleanup === 'function' ? maybeCleanup : undefined
		} catch (err) {
			this.ctx.logger.error('handler crashed', { error: err })
			return undefined
		}
	}

	private parseNamespaces(params: URLSearchParams): string[] {
		const raw = params.get('ns') ?? params.get('namespace') ?? params.get('namespaces')
		if (!raw) return this.listNamespaces()
		return raw
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean)
	}

	private normalizeNamespaces(namespaces: string[]): string[] {
		return [...new Set(namespaces.filter(Boolean))]
	}

	private normalizeSubscriptions(subscriptions: StreamSubscription[]): StreamSubscription[] {
		const normalized = new Map<string, string>()
		for (const subscription of subscriptions) {
			const key = String(subscription.key ?? '').trim()
			const namespace = String(subscription.namespace ?? '').trim()
			if (!key || !namespace) continue
			const existing = normalized.get(key)
			if (existing && existing !== namespace) {
				throw new Error(`[workbench] stream alias "${key}" resolves to multiple resources`)
			}
			normalized.set(key, namespace)
		}
		return [...normalized].map(([key, namespace]) => ({ key, namespace }))
	}

	private markPending(namespace: string, session: Session<SessionState>, key: string) {
		let sessions = this.pendingByNamespace.get(namespace)
		if (!sessions) {
			sessions = new Map()
			this.pendingByNamespace.set(namespace, sessions)
		}
		let keys = sessions.get(session)
		if (!keys) {
			keys = new Set()
			sessions.set(session, keys)
		}
		keys.add(key)
	}

	private unmarkPending(namespace: string, session: Session<SessionState>, key: string) {
		const sessions = this.pendingByNamespace.get(namespace)
		const keys = sessions?.get(session)
		if (!sessions || !keys) return
		keys.delete(key)
		if (keys.size === 0) sessions.delete(session)
		if (sessions.size === 0) this.pendingByNamespace.delete(namespace)
	}

	private tryAttachPending(namespace: string) {
		const waiters = this.pendingByNamespace.get(namespace)
		if (!waiters?.size) return
		const sessions = [...waiters]
		for (const [session, keys] of sessions) {
			if (!session.isConnected) {
				waiters.delete(session)
				continue
			}
			for (const key of keys) this.scheduleSubscriptionAttachment(session, key)
		}
		if (waiters.size === 0) this.pendingByNamespace.delete(namespace)
	}

	private cleanupSession(session: Session<SessionState>) {
		this.sessions.delete(session)
		for (const [namespace, sessions] of this.pendingByNamespace) {
			if (!sessions.delete(session)) continue
			if (sessions.size === 0) this.pendingByNamespace.delete(namespace)
		}

		for (const attachment of session.state.handlers.values()) {
			if (!attachment.cleanup) continue
			this.runCleanup(attachment.cleanup, attachment.namespace)
		}
		session.state.handlers.clear()
	}

	private detachNamespace(namespace: string) {
		for (const session of this.sessions) {
			for (const [key, attachment] of session.state.handlers) {
				if (attachment.namespace !== namespace) continue
				if (attachment.cleanup) this.runCleanup(attachment.cleanup, namespace)
				session.state.handlers.delete(key)
				if (session.isConnected && session.state.requested.get(key) === namespace) {
					this.markPending(namespace, session, key)
				}
			}
		}
	}

	private runCleanup(cleanup: () => void | Promise<void>, namespace: string) {
		try {
			Promise.resolve(cleanup()).catch((err) => {
				this.ctx.logger.warn('cleanup failed for "{namespace}"', { namespace, error: err })
			})
		} catch (err) {
			this.ctx.logger.warn('cleanup failed for "{namespace}"', { namespace, error: err })
		}
	}

	private scheduleSubscriptionAttachment(session: Session<SessionState>, key: string): void {
		void this.attachSubscriptionToSession(session, key).catch((error: unknown) => {
			this.ctx.logger.error('Workbench stream subscription attach failed', { error, key })
		})
	}

	private rebindNamespace(namespace: string) {
		for (const session of this.sessions) {
			if (!session.isConnected) continue
			for (const [key, requestedNamespace] of session.state.requested) {
				if (requestedNamespace !== namespace) continue
				this.scheduleSubscriptionAttachment(session, key)
			}
		}
	}
}

export type { ResolvedSseEvents } from '../../../web/sse'
