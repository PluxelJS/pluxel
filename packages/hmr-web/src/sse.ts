import type { ExtensionManifestEvent } from './plugin-ui'
import { defaultOnAuthBlocked, type OnAuthBlocked } from './auth'
import type { UI } from './protocol'

export interface LogRecord {
	time: string
	level: number | string
	name?: string
	msg: string
	[key: string]: unknown
}

export interface BuiltinSseEvents {
	extensions: ExtensionManifestEvent
	logs: LogRecord
}

export type ResolvedSseEvents = BuiltinSseEvents & UI.sse

type PayloadForNs<Ns extends string> = Ns extends keyof ResolvedSseEvents
	? ResolvedSseEvents[Ns]
	: unknown

export type SseMessage<Ns extends string = keyof ResolvedSseEvents> = {
	namespace: Ns
	event: string
	payload: PayloadForNs<Ns>
	raw: MessageEvent
}

type AnyHandler = (msg: SseMessage<string>) => void

type NamespaceClient<Ns extends string> = {
	on(handler: (msg: SseMessage<Ns>) => void, events?: string | string[]): () => void
	onAny(handler: (msg: SseMessage<Ns>) => void): () => void
}

export type SseClientWithNamespaces = SseClient & {
	ns<Ns extends string>(name: Ns): NamespaceClient<Ns>
} & {
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
	/**
	 * Optional auth integration: when SSE errors, we can probe auth state and redirect
	 * instead of reconnecting forever.
	 */
	auth?: {
		metaUrl: string
		fetch?: typeof fetch
		onBlocked?: OnAuthBlocked
	}
}

class SseClient {
	private source: EventSource | null = null
	private readonly anyHandlers = new Set<AnyHandler>()
	private readonly nsHandlers = new Map<
		string,
		{ any: Set<AnyHandler>; events: Map<string, Set<AnyHandler>> }
	>()
	private readonly lastByNamespace = new Map<string, SseMessage<string>>()
	private readonly lastByNamespaceEvent = new Map<string, Map<string, SseMessage<string>>>()
	private readonly openHandlers = new Set<() => void>()
	private readonly errorHandlers = new Set<() => void>()
	private stopped = false
	private reconnectTimer: number | null = null
	private backoff: number
	private readonly retryMin: number
	private readonly retryMax: number
	private readonly url: string
	private readonly auth?: NonNullable<SseClientOptions['auth']>
	private authProbeInFlight: Promise<boolean> | null = null
	private lastAuthProbeAt = 0
	private connected = false

	private static readonly MAX_CACHED_EVENTS_PER_NAMESPACE = 64
	private static asap(fn: () => void) {
		if (typeof globalThis.queueMicrotask === 'function') globalThis.queueMicrotask(fn)
		else Promise.resolve().then(fn)
	}

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
		this.auth = options.auth

		this.connect()
	}

	private async probeAuthBlocked(): Promise<boolean> {
		const auth = this.auth
		if (!auth?.metaUrl) return false

		const now = Date.now()
		// Throttle probes: avoid spamming auth/meta on flaky networks.
		if (now - this.lastAuthProbeAt < 1500) return false
		this.lastAuthProbeAt = now

		const fetchImpl =
			auth.fetch ??
			(typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined)
		if (!fetchImpl) return false

		try {
			const res = await fetchImpl(auth.metaUrl, {
				method: 'GET',
				headers: { 'Cache-Control': 'no-store' },
			})
			if (!res.ok) return false
			const payload = (await res.json()) as any
			if (!payload || payload.enabled !== true) return false
			if (payload.authenticated === true) return false

			const redirectPath =
				typeof payload.redirectPath === 'string' && payload.redirectPath
					? payload.redirectPath
					: undefined
			const onBlocked = auth.onBlocked ?? defaultOnAuthBlocked
			onBlocked({ status: 401, url: this.url, redirectPath })
			return true
		} catch {
			return false
		}
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
		this.connected = false
		try {
			this.source?.close()
		} catch {
			void 0
		}
		const src = new EventSource(this.url)
		this.source = src

		src.onopen = () => {
			this.connected = true
			this.backoff = this.retryMin
			for (const fn of this.openHandlers) fn()
		}
		src.onerror = () => {
			this.connected = false
			for (const fn of this.errorHandlers) fn()
			if (this.auth && typeof window !== 'undefined') {
				if (!this.authProbeInFlight) {
					this.authProbeInFlight = this.probeAuthBlocked().finally(() => {
						this.authProbeInFlight = null
					})
				}
				void this.authProbeInFlight.then((blocked) => {
					if (blocked) {
						this.close()
						return
					}
					this.scheduleReconnect()
				})
				return
			}
			this.scheduleReconnect()
		}
		src.onmessage = (ev) => {
			let msg: { namespace?: unknown; event?: unknown; payload?: unknown } | null = null
			try {
				msg = JSON.parse(ev.data) as { namespace?: unknown; event?: unknown; payload?: unknown }
			} catch {
				return
			}
			const namespace = String(msg?.namespace ?? '')
			const event = String(msg?.event ?? '')
			const payload = msg?.payload
			const shaped: SseMessage<string> = {
				namespace,
				event,
				payload,
				raw: ev,
			}
			this.cacheLast(shaped)
			for (const fn of this.anyHandlers) fn(shaped)
			const bucket = this.nsHandlers.get(namespace)
			if (!bucket) return
			for (const fn of bucket.any) fn(shaped)
			const set = bucket.events.get(event)
			if (set) for (const fn of set) fn(shaped)
		}
	}

	private cacheLast(msg: SseMessage<string>) {
		const ns = msg.namespace
		const ev = msg.event

		this.lastByNamespace.set(ns, msg)

		let byEvent = this.lastByNamespaceEvent.get(ns)
		if (!byEvent) {
			byEvent = new Map()
			this.lastByNamespaceEvent.set(ns, byEvent)
		}
		if (!byEvent.has(ev) && byEvent.size >= SseClient.MAX_CACHED_EVENTS_PER_NAMESPACE) {
			const oldest = byEvent.keys().next().value as string | undefined
			if (oldest) byEvent.delete(oldest)
		}
		byEvent.set(ev, msg)
	}

	onOpen(handler: () => void): () => void {
		this.openHandlers.add(handler)
		if (this.connected) {
			SseClient.asap(() => {
				if (this.openHandlers.has(handler)) handler()
			})
		}
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
		return () => {
			for (const fn of unsubs) fn()
		}
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
				if (!list.length) {
					const h = handler as unknown as AnyHandler
					bucket!.any.add(h)
					const last = this.lastByNamespace.get(namespace)
					if (last) {
						SseClient.asap(() => {
							if (bucket!.any.has(h)) h(last)
						})
					}
					return () => bucket!.any.delete(h)
				}
				const unsubs: Array<() => void> = []
				for (const ev of list) {
					let set = bucket!.events.get(ev)
					if (!set) {
						set = new Set()
						bucket!.events.set(ev, set)
					}
					const h = handler as unknown as AnyHandler
					set.add(h)
					const last = this.lastByNamespaceEvent.get(namespace)?.get(ev)
					if (last) {
						SseClient.asap(() => {
							if (set!.has(h)) h(last)
						})
					}
					unsubs.push(() => set!.delete(h))
				}
				return () => {
					for (const fn of unsubs) fn()
				}
			},
			onAny: (handler) => {
				const h = handler as unknown as AnyHandler
				bucket!.any.add(h)
				const last = this.lastByNamespace.get(namespace)
				if (last) {
					SseClient.asap(() => {
						if (bucket!.any.has(h)) h(last)
					})
				}
				return () => bucket!.any.delete(h)
			},
		}
	}

	close(): void {
		this.stopped = true
		this.connected = false
		this.lastByNamespace.clear()
		this.lastByNamespaceEvent.clear()
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer)
			this.reconnectTimer = null
		}
		try {
			this.source?.close()
		} catch {
			void 0
		}
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
