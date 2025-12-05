import type { ExtensionManifestEvent } from "../services/extension"
import type { SseEvents } from "../services/hono/SseService"

export interface LogRecord {
	time: string
	level: number | string
	name?: string
	msg: string
	[key: string]: any
}

export interface BuiltinSseEvents {
	extensions: ExtensionManifestEvent
	logs: LogRecord
}

export type ResolvedSseEvents = BuiltinSseEvents & SseEvents

type PayloadForNs<Ns extends string> = Ns extends keyof ResolvedSseEvents
	? ResolvedSseEvents[Ns]
	: unknown

export type SseMessage<Ns extends string = keyof ResolvedSseEvents> = {
	namespace: Ns
	event: string
	payload: PayloadForNs<Ns>
	raw: MessageEvent
}

type AnyHandler = (msg: SseMessage<any>) => void

type NamespaceClient<Ns extends string> = {
	on(handler: (msg: SseMessage<Ns>) => void, events?: string | string[]): () => void
	onAny(handler: (msg: SseMessage<Ns>) => void): () => void
}

export type SseClientWithNamespaces = SseClient &
	{ ns<Ns extends string>(name: Ns): NamespaceClient<Ns> } & {
		[K in keyof ResolvedSseEvents]: NamespaceClient<K & string>
	}

export interface SseClientOptions {
	/** 想要订阅的命名空间，默认全量 */
	namespaces?: Array<keyof ResolvedSseEvents | string>
	/** 额外查询参数（会附加到 /api/sse） */
	params?: Record<string, string | number | boolean | null | undefined>
	/** 自定义 SSE 入口（默认 /api/sse） */
	url?: string
	retry?: { min?: number; max?: number }
}

class SseClient {
	private source: EventSource | null = null
	private readonly anyHandlers = new Set<AnyHandler>()
	private readonly nsHandlers = new Map<
		string,
		{ any: Set<AnyHandler>; events: Map<string, Set<AnyHandler>> }
	>()
	private readonly openHandlers = new Set<() => void>()
	private readonly errorHandlers = new Set<() => void>()
	private stopped = false
	private reconnectTimer: number | null = null
	private backoff: number
	private readonly retryMin: number
	private readonly retryMax: number
	private readonly url: string

	constructor(options: SseClientOptions = {}) {
		const min = options.retry?.min ?? 800
		const max = options.retry?.max ?? 10_000
		this.retryMin = min
		this.retryMax = max
		this.backoff = min

		const url = new URL(options.url ?? '/api/sse', window.location.origin)
		const namespaces = options.namespaces?.filter(Boolean)
		if (namespaces?.length) url.searchParams.set('ns', namespaces.join(','))
		if (options.params) {
			for (const [k, v] of Object.entries(options.params)) {
				if (v === undefined || v === null) continue
				url.searchParams.set(k, String(v))
			}
		}
		this.url = url.toString()

		this.connect()
	}

	on<Ns extends string>(
		namespace: Ns,
		handler: (msg: SseMessage<Ns>) => void,
		events?: string | string[],
	): () => void {
		const bucket = this.getNamespaceBucket(namespace as string)
		const list = Array.isArray(events) ? events : events ? [events] : []
		if (list.length === 0) {
			bucket.any.add(handler as AnyHandler)
			return () => bucket.any.delete(handler as AnyHandler)
		}
		const disposers: Array<() => void> = []
		for (const ev of list) {
			const set = bucket.events.get(ev) ?? new Set<AnyHandler>()
			set.add(handler as AnyHandler)
			bucket.events.set(ev, set)
			disposers.push(() => set.delete(handler as AnyHandler))
		}
		return () => {
			for (const dispose of disposers) dispose()
		}
	}

	onAny(handler: AnyHandler): () => void {
		this.anyHandlers.add(handler)
		return () => this.anyHandlers.delete(handler)
	}

	onOpen(handler: () => void): () => void {
		this.openHandlers.add(handler)
		return () => this.openHandlers.delete(handler)
	}

	onError(handler: () => void): () => void {
		this.errorHandlers.add(handler)
		return () => this.errorHandlers.delete(handler)
	}

	ns<N extends string>(name: N): NamespaceClient<N> {
		return {
			on: (handler, events) => this.on(name as any, handler as any, events),
			onAny: (handler) => this.on(name as any, handler as any),
		}
	}

	close() {
		this.stopped = true
		if (this.reconnectTimer != null) {
			clearTimeout(this.reconnectTimer)
			this.reconnectTimer = null
		}
		this.source?.close()
		this.source = null
	}

	private getNamespaceBucket(namespace: string) {
		let bucket = this.nsHandlers.get(namespace)
		if (!bucket) {
			bucket = { any: new Set<AnyHandler>(), events: new Map<string, Set<AnyHandler>>() }
			this.nsHandlers.set(namespace, bucket)
		}
		return bucket
	}

	private connect() {
		this.source = new EventSource(this.url)
		this.source.onmessage = (ev) => this.dispatch(ev)
		this.source.onerror = () => {
			this.source?.close()
			this.source = null
			for (const h of this.errorHandlers) h()
			if (this.stopped) return
			const delay = this.backoff
			this.backoff = Math.min(this.backoff * 2, this.retryMax)
			this.reconnectTimer = window.setTimeout(() => this.connect(), delay)
		}
		this.source.onopen = () => {
			this.backoff = this.retryMin
			for (const h of this.openHandlers) h()
		}
	}

	private dispatch(ev: MessageEvent) {
		let payload: any = null
		try {
			payload = JSON.parse(ev.data)
		} catch (error) {
			if (process.env.NODE_ENV !== 'production') {
				console.warn('[SSE] invalid payload', error)
			}
			return
		}
		if (!payload || typeof payload !== 'object') return
		const namespace = payload.namespace as string
		if (typeof namespace !== 'string' || !namespace) return
		const event = typeof payload.event === 'string' ? payload.event : 'message'
		const envelope = { namespace, event, payload: payload.payload, raw: ev } as SseMessage

		for (const h of this.anyHandlers) h(envelope)

		const bucket = this.nsHandlers.get(namespace)
		if (!bucket) return
		for (const h of bucket.any) h(envelope)
		const targets = bucket.events.get(event)
		if (!targets) return
		for (const h of targets) h(envelope)
	}
}

/**
 * 前端统一 SSE 客户端，可声明式按命名空间订阅。
 * @example
 * const stream = sse({ namespaces: ['extensions'] })
 * const off = stream.extensions.on(({ payload }) => {
 *   console.log(payload.type) // ExtensionManifestEvent
 * })
 * // 或显式命名空间：
 * // const off = stream.ns('my-plugin').on((msg) => console.log(msg.payload))
 * // ...
 * off(); stream.close()
 */
export function sse(options?: SseClientOptions): SseClientWithNamespaces {
	const client = new SseClient(options)
	const cache = new Map<string, NamespaceClient<string>>()

	const getNamespace = (name: string) => {
		let view = cache.get(name)
		if (!view) {
			view = client.ns(name)
			cache.set(name, view)
		}
		return view
	}

	const proxy = new Proxy(client as SseClientWithNamespaces, {
		get(target, prop, receiver) {
			if (prop === 'ns') return target.ns.bind(target)
			if (typeof prop === 'string' && !(prop in target)) {
				return getNamespace(prop)
			}
			return Reflect.get(target, prop, receiver)
		},
	})

	return proxy
}
