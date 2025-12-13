import type { ExtensionManifestEvent } from '@pluxel/plugin-ui'
import type { SseEvents } from './protocol'

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

	private scheduleReconnect() {
		if (this.stopped) return
		if (this.reconnectTimer) return
		const delay = this.backoff
		this.backoff = Math.min(this.retryMax, Math.max(this.retryMin, Math.floor(this.backoff * 1.35)))
		this.reconnectTimer = window.setTimeout(() => {
			this.reconnectTimer = null
			this.connect()
		}, delay)
	}

	private connect() {
		if (this.stopped) return
		try {
			this.source?.close()
		} catch {}
		const src = new EventSource(this.url)
		this.source = src

		src.onopen = () => {
			this.backoff = this.retryMin
			for (const fn of this.openHandlers) fn()
		}
		src.onerror = () => {
			for (const fn of this.errorHandlers) fn()
			this.scheduleReconnect()
		}
		src.onmessage = (ev) => {
			let msg: any = null
			try {
				msg = JSON.parse(ev.data)
			} catch {
				return
			}
			const namespace = String(msg?.namespace ?? '')
			const event = String(msg?.event ?? '')
			const payload = msg?.payload
			const shaped: SseMessage = {
				namespace,
				event,
				payload,
				raw: ev,
			}
			for (const fn of this.anyHandlers) fn(shaped)
			const bucket = this.nsHandlers.get(namespace)
			if (!bucket) return
			for (const fn of bucket.any) fn(shaped)
			const set = bucket.events.get(event)
			if (set) for (const fn of set) fn(shaped)
		}
	}

	onOpen(handler: () => void): () => void {
		this.openHandlers.add(handler)
		return () => this.openHandlers.delete(handler)
	}

	onError(handler: () => void): () => void {
		this.errorHandlers.add(handler)
		return () => this.errorHandlers.delete(handler)
	}

	onAny(handler: AnyHandler): () => void {
		this.anyHandlers.add(handler)
		return () => this.anyHandlers.delete(handler)
	}

	on(handler: AnyHandler, namespaces?: string | string[]): () => void {
		const list = Array.isArray(namespaces) ? namespaces : namespaces ? [namespaces] : []
		if (!list.length) return this.onAny(handler)
		const unsubs: Array<() => void> = []
		for (const ns of list) unsubs.push(this.ns(ns).onAny(handler))
		return () => unsubs.forEach((fn) => fn())
	}

	ns<Ns extends string>(name: Ns): NamespaceClient<Ns> {
		const namespace = String(name)
		let bucket = this.nsHandlers.get(namespace)
		if (!bucket) {
			bucket = { any: new Set(), events: new Map() }
			this.nsHandlers.set(namespace, bucket)
		}
		return {
			on: (handler, events) => {
				const list = Array.isArray(events) ? events : events ? [events] : []
				if (!list.length) return this.onAny(handler)
				const unsubs: Array<() => void> = []
				for (const ev of list) {
					let set = bucket!.events.get(ev)
					if (!set) {
						set = new Set()
						bucket!.events.set(ev, set)
					}
					set.add(handler as any)
					unsubs.push(() => set!.delete(handler as any))
				}
				return () => unsubs.forEach((fn) => fn())
			},
			onAny: (handler) => {
				bucket!.any.add(handler as any)
				return () => bucket!.any.delete(handler as any)
			},
		}
	}

	close(): void {
		this.stopped = true
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer)
			this.reconnectTimer = null
		}
		try {
			this.source?.close()
		} catch {}
		this.source = null
	}
}

export function sse(options: SseClientOptions = {}): SseClientWithNamespaces {
	const client = new SseClient(options) as SseClientWithNamespaces
	return new Proxy(client, {
		get(target, prop, receiver) {
			if (prop === 'ns') return target.ns.bind(target)
			if (typeof prop === 'string' && !(prop in target)) return target.ns(prop)
			return Reflect.get(target, prop, receiver)
		},
	})
}
