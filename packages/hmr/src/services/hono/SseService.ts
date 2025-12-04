import { type Context, Injectable } from '@pluxel/core'
import { type SSEStreamingApi, streamSSE } from 'hono/streaming'

import type { AppEnv } from './env'

const serviceName = 'sse' as const

declare module '@pluxel/core' {
	interface Context {
		[serviceName]: SseService
	}
}

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

type SSEMessage = {
	data?: string
	event?: string
	id?: string
	retry?: number
	comment?: string
}

@Injectable({ key: serviceName })
export class SseService {
	private extensions = new Map<string, SseExtensionFactory>()
	private static readonly KEEPALIVE_MS = 25_000
	private static readonly KEEPALIVE_EVENT: SSEMessage = {
		comment: 'keep-alive',
		data: '',
	}

	constructor(private ctx: Context) {}

	registerExtension(factory: SseExtensionFactory, options: RegisterOptions = {}): () => void {
		const namespace = options.namespace ?? this.ctx.pluginInfo?.name
		if (!namespace) throw new Error('[SSE] registerExtension: namespace required')

		if (this.extensions.has(namespace)) {
			this.ctx.logger?.warn(`[SSE] Extension "${namespace}" already registered, overwriting`)
		}

		this.extensions.set(namespace, factory)

		return this.ctx.scope.collectEffect(() => {
			if (this.extensions.get(namespace) === factory) this.extensions.delete(namespace)
		})
	}

	stream(c: import('hono').Context<AppEnv>, namespaces?: string[]) {
		const params = new URL(c.req.url).searchParams
		const requestedRaw = this.normalizeNamespaces(namespaces ?? this.parseNamespaces(params))
		const available: string[] = []
		const missing: string[] = []

		for (const ns of requestedRaw) {
			(this.hasExtension(ns) ? available : missing).push(ns)
		}

		if (available.length === 0 && missing.length === 0) {
			return c.text('No SSE extensions registered', 404)
		}

		if (missing.length) {
			c.var.plugin_ctx.logger?.warn?.('[SSE] namespaces missing, fallback', missing)
		}

		return streamSSE(c, async (sse) => {
			let closed = false
			const cleanups: Array<() => void | Promise<void>> = []

			const channelBase = {
				query: params,
				hono: c,
				ctx: this.ctx,
				get closed() {
					return closed
				},
				onAbort(cb: () => void) {
					sse.onAbort(cb)
				},
			} as const

			const tryAttach = () => {
				for (let i = missing.length - 1; i >= 0; i--) {
					const ns = missing[i]!
					const factory = this.extensions.get(ns)
					if (!factory) continue
					missing.splice(i, 1)
					const channel = this.createChannel(ns, sse, channelBase)
					void this.runHandler(factory, channel, cleanups)
				}
			}

			const runInitial = async () => {
				for (const namespace of available) {
					const factory = this.extensions.get(namespace)
					if (!factory) continue
					const channel = this.createChannel(namespace, sse, channelBase)
					await this.runHandler(factory, channel, cleanups)
				}
				tryAttach()
			}

			const heartbeat = setInterval(() => {
				if (closed) return
				this.writeSseSafely(sse, SseService.KEEPALIVE_EVENT)
				tryAttach()
			}, SseService.KEEPALIVE_MS)

			sse.onAbort(() => {
				closed = true
				clearInterval(heartbeat)
			})

			await runInitial()

			await this.awaitAbort(sse)
			clearInterval(heartbeat)
			await this.runCleanups(cleanups)
		})
	}

	getNamespaces(): string[] {
		return Array.from(this.extensions.keys())
	}

	hasExtension(namespace: string): boolean {
		return this.extensions.has(namespace)
	}

	private createChannel(
		namespace: string,
		sse: SSEStreamingApi,
		base: Omit<SseChannel, 'namespace' | 'send' | 'emit'>,
	): SseChannel {
		const send = (payload: SsePayload) => {
			if (base.closed) return
			const message = this.normalizePayload(namespace, payload)
			this.writeSseSafely(sse, message)
		}

		const emit = (
			event: string,
			data?: unknown,
			extras?: Omit<SseEventPayload, 'data' | 'event'>,
		) => send({ ...(extras ?? {}), event, data })

		return { namespace, ...base, send, emit }
	}

	private normalizePayload(namespace: string, payload: SsePayload): SSEMessage | null {
		if (payload === undefined) return null
		const { event, data, id, retry, comment, raw } = payload as SseEventPayload
		const eventName = event ?? namespace
		const body =
			typeof payload === 'object' && payload !== null && !(payload instanceof Date)
				? 'data' in payload
					? data
					: payload
				: payload

		// 使用默认 message 事件，避免浏览器只走自定义事件监听
		return {
			id,
			retry,
			comment,
			data: raw
				? this.stringify(body)
				: this.stringify({ namespace, event: eventName, payload: body ?? null }),
		}
	}

	/** Hono 的 writeSSE 要求 data 不为 undefined，这里做一次兜底 */
	private writeSseSafely(sse: SSEStreamingApi, message: SSEMessage | null | undefined) {
		if (!message) return
		if (message.data === undefined) {
			message = { ...message, data: '' }
		}
		try {
			sse.writeSSE(message)
		} catch (err) {
			this.ctx.logger?.warn('[SSE] write failed', err)
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
		factory: SseExtensionFactory,
		channel: SseChannel,
		cleanups: Array<() => void | Promise<void>>,
	) {
		try {
			const handler = factory(this.ctx)
			const maybeCleanup = await handler(channel)
			if (typeof maybeCleanup === 'function') cleanups.push(maybeCleanup)
		} catch (err) {
			this.ctx.logger?.error?.('[SSE] handler crashed', err)
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

	private async runCleanups(cleanups: Array<() => void | Promise<void>>) {
		for (let i = cleanups.length - 1; i >= 0; i--) {
			const fn = cleanups[i]
			try {
				await fn()
			} catch (err) {
				this.ctx.logger?.warn('[SSE] cleanup failed', err)
			}
		}
	}

	private normalizeNamespaces(namespaces: string[]): string[] {
		return Array.from(new Set(namespaces.filter(Boolean)))
	}

	private awaitAbort(sse: SSEStreamingApi): Promise<void> {
		return new Promise((resolve) => sse.onAbort(resolve))
	}
}

export type { ResolvedSseEvents, SseEvents } from '../../web/sse'
