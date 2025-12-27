import { type Context } from '@pluxel/core'
import { createResponse, type Session } from 'better-sse'
import type { SseEvents } from '../extensions'

import type { AppEnv } from '../hono/env'

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
	/** Hono 请求上下文 */
	hono: import('hono').Context<AppEnv>
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
export type SseExtensionFactory = (ctx: Context) => SseHandler

interface RegisterOptions {
	namespace?: string
}

type SessionState = {
	requested: Set<string>
	handlers: Map<string, () => void | Promise<void>>
	query?: URLSearchParams
	honoCtx?: import('hono').Context<AppEnv>
}

export class SseService {
	private extensions = new Map<string, SseExtensionFactory>()
	private readonly sessions = new Set<Session<SessionState>>()
	private readonly pendingByNamespace = new Map<string, Set<Session<SessionState>>>()
	private static readonly KEEPALIVE_MS = 25_000
	private static readonly RETRY_MS = 2_000

	constructor(public ctx: Context, _cfg: unknown = undefined) {}

	registerExtension(factory: SseExtensionFactory, options: RegisterOptions = {}): () => void {
		const namespace = options.namespace ?? this.ctx.pluginInfo.id
		if (!namespace) throw new Error('[SSE] registerExtension: namespace required')

		const already = this.extensions.has(namespace)
		if (already) {
			this.ctx.logger.warn(`[SSE] Extension "${namespace}" already registered, refreshing`)
			this.detachNamespace(namespace)
		}

		this.extensions.set(namespace, factory)
		this.rebindNamespace(namespace)
		this.tryAttachPending(namespace)

		return this.ctx.scope.collectEffect(() => {
			if (this.extensions.get(namespace) !== factory) return
			this.extensions.delete(namespace)
			this.detachNamespace(namespace)
		})
	}

	stream(c: import('hono').Context<AppEnv>, namespaces?: string[]) {
		const params = new URL(c.req.url).searchParams
		const requestedRaw = this.normalizeNamespaces(namespaces ?? this.parseNamespaces(params))
		const available: string[] = []
		const missing: string[] = []

		for (const ns of requestedRaw) {
			;(this.hasExtension(ns) ? available : missing).push(ns)
		}

		if (available.length === 0 && missing.length === 0) {
			return c.text('No SSE extensions registered', 404)
		}

		if (missing.length) {
			c.var.plugin_ctx.logger.warn('[SSE] namespaces missing, fallback', missing)
		}

		return createResponse<SessionState>(
			c.req.raw,
			{
				keepAlive: SseService.KEEPALIVE_MS,
				retry: SseService.RETRY_MS,
				serializer: (value) => this.stringify(value),
				state: {
					requested: new Set(requestedRaw),
					handlers: new Map(),
				},
			},
			(session) => this.attachSession(session, c, params, available, missing),
		)
	}

	getNamespaces(): string[] {
		return Array.from(this.extensions.keys())
	}

	hasExtension(namespace: string): boolean {
		return this.extensions.has(namespace)
	}

	private attachSession(
		session: Session<SessionState>,
		honoCtx: import('hono').Context<AppEnv>,
		query: URLSearchParams,
		available: string[],
		missing: string[],
	) {
		this.sessions.add(session)
		const clean = () => this.cleanupSession(session)
		session.once('disconnected', clean)

		session.state.honoCtx = honoCtx
		session.state.query = query

		for (const ns of available) {
			void this.attachNamespaceToSession(session, ns)
		}

		for (const ns of missing) {
			this.markPending(ns, session)
			void this.attachNamespaceToSession(session, ns)
		}
	}

	private createChannelBase(
		session: Session<SessionState>,
		honoCtx: import('hono').Context<AppEnv>,
		query: URLSearchParams,
	): Omit<SseChannel, 'namespace' | 'send' | 'emit'> {
		return {
			query,
			hono: honoCtx,
			ctx: this.ctx,
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

	private async attachNamespaceToSession(session: Session<SessionState>, namespace: string) {
		const state = session.state
		if (state.handlers.has(namespace)) return
		const factory = this.extensions.get(namespace)
		if (!factory) {
			this.markPending(namespace, session)
			return
		}

		this.unmarkPending(namespace, session)

		const honoCtx = state.honoCtx
		if (!honoCtx) {
			this.ctx.logger.warn('[SSE] missing Hono context for session, skip attach')
			return
		}

		const base = this.createChannelBase(
			session,
			honoCtx,
			state.query ?? new URL(session.getRequest().url).searchParams,
		)
		const channel = this.createChannel(namespace, session, base)
		const cleanup = await this.runHandler(factory, channel)
		state.handlers.set(namespace, cleanup)
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
				this.ctx.logger.warn('[SSE] push failed', err)
			}
		}

		const emit = (
			event: string,
			data?: unknown,
			extras?: Omit<SseEventPayload, 'data' | 'event'>,
		) => send({ ...(extras ?? {}), event, data })

		return { namespace, ...base, send, emit }
	}

	private normalizePayload(
		namespace: string,
		payload: SsePayload,
	): { data: string; event?: string; id?: string } | null {
		if (payload === undefined) return null
		const { event, data, id, raw } = payload as SseEventPayload
		const eventName = event ?? namespace
		const body =
			typeof payload === 'object' && payload !== null && !(payload instanceof Date)
				? 'data' in payload
					? data
					: payload
				: payload

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

	private async runHandler(factory: SseExtensionFactory, channel: SseChannel) {
		try {
			const handler = factory(this.ctx)
			const maybeCleanup = await handler(channel)
			return typeof maybeCleanup === 'function' ? maybeCleanup : undefined
		} catch (err) {
			this.ctx.logger.error('[SSE] handler crashed', err)
		}
	}

	private parseNamespaces(params: URLSearchParams): string[] {
		const raw = params.get('ns') ?? params.get('namespace') ?? params.get('namespaces')
		if (!raw) return this.getNamespaces()
		return raw
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean)
	}

	private normalizeNamespaces(namespaces: string[]): string[] {
		return Array.from(new Set(namespaces.filter(Boolean)))
	}

	private markPending(namespace: string, session: Session<SessionState>) {
		let set = this.pendingByNamespace.get(namespace)
		if (!set) {
			set = new Set()
			this.pendingByNamespace.set(namespace, set)
		}
		set.add(session)
	}

	private unmarkPending(namespace: string, session: Session<SessionState>) {
		const set = this.pendingByNamespace.get(namespace)
		if (!set) return
		set.delete(session)
		if (set.size === 0) this.pendingByNamespace.delete(namespace)
	}

	private tryAttachPending(namespace: string) {
		const waiters = this.pendingByNamespace.get(namespace)
		if (!waiters?.size) return
		for (const session of Array.from(waiters)) {
			if (!session.isConnected) {
				this.unmarkPending(namespace, session)
				continue
			}
			void this.attachNamespaceToSession(session, namespace)
		}
	}

	private cleanupSession(session: Session<SessionState>) {
		this.sessions.delete(session)
		for (const [ns, set] of this.pendingByNamespace) {
			if (!set.delete(session)) continue
			if (set.size === 0) this.pendingByNamespace.delete(ns)
		}

		for (const [namespace, cleanup] of session.state.handlers) {
			if (!cleanup) continue
			this.runCleanup(cleanup, namespace)
		}
		session.state.handlers.clear()
	}

	private detachNamespace(namespace: string) {
		const set = this.pendingByNamespace.get(namespace)
		if (set) {
			set.clear()
			this.pendingByNamespace.delete(namespace)
		}

		for (const session of this.sessions) {
			const cleanup = session.state.handlers.get(namespace)
			if (!cleanup) continue
			this.runCleanup(cleanup, namespace)
			session.state.handlers.delete(namespace)
		}
	}

	private runCleanup(cleanup: () => void | Promise<void>, namespace: string) {
		Promise.resolve(cleanup()).catch((err) => {
			this.ctx.logger.warn(`[SSE] cleanup failed for "${namespace}"`, err)
		})
	}

	private rebindNamespace(namespace: string) {
		for (const session of this.sessions) {
			if (!session.isConnected) continue
			if (!session.state.requested.has(namespace)) continue
			void this.attachNamespaceToSession(session, namespace)
		}
	}
}

export type { ResolvedSseEvents } from '../../web/sse'
