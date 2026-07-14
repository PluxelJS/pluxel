import { defaultOnAdminAccessBlocked, type OnAdminAccessBlocked } from './admin-access'
import { RUNTIME_INTERNAL_API_BASE } from './paths'
import { resolveAdminAccessLandingPath, type AdminAccessReason } from '../shared/admin-access-http'

export interface BuiltinSseEvents {
	'management.layouts': { revision?: number } | number
}

export type ResolvedSseEvents = BuiltinSseEvents

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

export type SseNamespaceClient<Ns extends string> = {
	on(handler: (msg: SseMessage<Ns>) => void, events?: string | string[]): () => void
	onAny(handler: (msg: SseMessage<Ns>) => void): () => void
}

export type SseClientWithNamespaces = SseClient & {
	ns<Ns extends string>(name: Ns): SseNamespaceClient<Ns>
} & {
	[K in keyof ResolvedSseEvents]: SseNamespaceClient<K & string>
}

export interface SseClientOptions {
	/** 想要订阅的命名空间，默认全量 */
	namespaces?: Array<keyof ResolvedSseEvents | string>
	/** 额外查询参数（会附加到 SSE url 上） */
	params?: Record<string, string | number | boolean | null | undefined>
	/** 自定义 SSE 入口（默认 `${RUNTIME_INTERNAL_API_BASE}/sse`） */
	url?: string
	/** Whether to send cookies/credentials for cross-origin SSE. */
	withCredentials?: boolean
	/**
	 * Optional admin access integration: when SSE errors, probe the admin gate and redirect
	 * instead of reconnecting forever.
	 */
	adminAccess?: {
		readState: () => Promise<{ allow: boolean; reason?: AdminAccessReason }>
		onBlocked?: OnAdminAccessBlocked
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
	private readonly openHandlers = new Set<() => void>()
	private readonly errorHandlers = new Set<() => void>()
	private stopped = false
	private readonly url: string
	private readonly adminAccess?: NonNullable<SseClientOptions['adminAccess']>
	private readonly withCredentials?: boolean
	private adminAccessProbeInFlight: Promise<boolean> | null = null
	private lastAdminAccessProbeAt = 0
	private connected = false

	private static asap(fn: () => void) {
		if (typeof globalThis.queueMicrotask === 'function') globalThis.queueMicrotask(fn)
		else Promise.resolve().then(fn)
	}

	constructor(
		options: SseClientOptions = {},
		private readonly onClose?: () => void,
	) {
		const url = new URL(options.url ?? `${RUNTIME_INTERNAL_API_BASE}/sse`, window.location.origin)
		const namespaces = options.namespaces?.filter(Boolean)
		if (namespaces?.length) url.searchParams.set('ns', namespaces.join(','))
		if (options.params) {
			for (const [k, v] of Object.entries(options.params)) {
				if (v === undefined || v === null) continue
				url.searchParams.set(k, String(v))
			}
		}
		this.url = url.toString()
		this.adminAccess = options.adminAccess
		this.withCredentials = options.withCredentials

		this.connect()
	}

	private async probeAdminAccessBlocked(): Promise<boolean> {
		const adminAccess = this.adminAccess
		if (!adminAccess) return false

		const now = Date.now()
		if (now - this.lastAdminAccessProbeAt < 1500) return false
		this.lastAdminAccessProbeAt = now

		try {
			const state = await adminAccess.readState()
			if (!state || state.allow === true) return false

			const onBlocked = adminAccess.onBlocked ?? defaultOnAdminAccessBlocked
			onBlocked({
				status: 401,
				url: this.url,
				redirectPath: resolveAdminAccessLandingPath(state.reason),
				reason: state.reason,
			})
			return true
		} catch {
			return false
		}
	}

	private connect() {
		if (this.stopped) return
		this.connected = false
		const src =
			typeof this.withCredentials === 'boolean'
				? new EventSource(this.url, { withCredentials: this.withCredentials })
				: new EventSource(this.url)
		this.source = src

		src.onopen = () => {
			this.connected = true
			for (const fn of this.openHandlers) fn()
		}
		src.onerror = () => {
			this.connected = false
			for (const fn of this.errorHandlers) fn()
			if (!this.adminAccess) return
			if (!this.adminAccessProbeInFlight) {
				this.adminAccessProbeInFlight = this.probeAdminAccessBlocked().finally(() => {
					this.adminAccessProbeInFlight = null
				})
			}
			void this.adminAccessProbeInFlight.then((blocked): undefined => {
				if (blocked) this.close()
				return undefined
			})
		}
		src.onmessage = (ev) => {
			let msg: { namespace?: unknown; event?: unknown; payload?: unknown } | null = null
			try {
				msg = JSON.parse(ev.data) as { namespace?: unknown; event?: unknown; payload?: unknown }
			} catch (error) {
				console.error('[runtime-sse] malformed event payload', error)
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
		this.lastByNamespace.set(ns, msg)
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
		if (list.length === 0) return this.onAny(handler)
		const unsubs: Array<() => void> = []
		for (const ns of list) unsubs.push(this.ns(ns).onAny(handler))
		return () => {
			for (const fn of unsubs) fn()
		}
	}

	ns<Ns extends string>(name: Ns): SseNamespaceClient<Ns> {
		const namespace = String(name)
		let bucket = this.nsHandlers.get(namespace)
		if (!bucket) {
			bucket = { any: new Set(), events: new Map() }
			this.nsHandlers.set(namespace, bucket)
		}
		return {
			on: (handler: (msg: SseMessage<Ns>) => void, events?: string | string[]) => {
				const list = Array.isArray(events) ? events : events ? [events] : []
				if (list.length === 0) {
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
					unsubs.push(() => set!.delete(h))
				}
				return () => {
					for (const fn of unsubs) fn()
				}
			},
			onAny: (handler: (msg: SseMessage<Ns>) => void) => {
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
		if (this.stopped) return
		this.stopped = true
		this.connected = false
		this.lastByNamespace.clear()
		this.anyHandlers.clear()
		this.nsHandlers.clear()
		this.openHandlers.clear()
		this.errorHandlers.clear()
		const source = this.source
		this.source = null
		try {
			if (source) {
				source.onopen = null
				source.onerror = null
				source.onmessage = null
				source.close()
			}
		} catch {
			void 0
		}
		this.onClose?.()
	}
}

export function sse(options: SseClientOptions = {}): SseClientWithNamespaces {
	return sseWithLifecycle(options)
}

/** @internal Create an SSE client that unregisters itself from its transport owner on close. */
export function sseWithLifecycle(
	options: SseClientOptions,
	onClose?: () => void,
): SseClientWithNamespaces {
	const client = new SseClient(options, onClose) as SseClientWithNamespaces
	return new Proxy(client, {
		get(target, prop, receiver) {
			if (prop === 'ns') return target.ns.bind(target)
			if (typeof prop === 'string' && !(prop in target)) return target.ns(prop)
			return Reflect.get(target, prop, receiver)
		},
	})
}
