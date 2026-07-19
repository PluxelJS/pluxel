import type { ConfiguredMiddleware, WretchOptions } from 'wretch'
import type { WretchPluginConfig } from './config.ts'

type QueueEntry = {
	resolve: (release: () => void) => void
	reject: (error: Error) => void
	signals: readonly AbortSignal[]
	onAbort?: () => void
}

function abortError(signal?: AbortSignal): Error {
	if (signal?.reason instanceof Error) return signal.reason
	return new DOMException('The request was aborted', 'AbortError')
}

class RequestScheduler {
	private active = 0
	private readonly queue: QueueEntry[] = []
	private stopped?: Error

	constructor(
		private readonly maxConcurrent: number,
		private readonly maxQueued: number,
	) {}

	acquire(rawSignals: readonly (AbortSignal | undefined)[]): Promise<() => void> {
		if (this.stopped) return Promise.reject(this.stopped)
		const signals = rawSignals.filter((signal): signal is AbortSignal => signal !== undefined)
		const aborted = signals.find((signal) => signal.aborted)
		if (aborted) return Promise.reject(abortError(aborted))
		if (this.active < this.maxConcurrent) {
			this.active += 1
			return Promise.resolve(this.releaseOnce())
		}
		if (this.queue.length >= this.maxQueued) {
			return Promise.reject(new Error('Outbound HTTP request queue is full'))
		}

		return new Promise((resolve, reject) => {
			const entry: QueueEntry = { resolve, reject, signals }
			if (signals.length > 0) {
				entry.onAbort = () => {
					const index = this.queue.indexOf(entry)
					if (index >= 0) this.queue.splice(index, 1)
					this.removeAbortListeners(entry)
					reject(abortError(signals.find((signal) => signal.aborted)))
				}
				for (const signal of signals) {
					signal.addEventListener('abort', entry.onAbort, { once: true })
				}
			}
			this.queue.push(entry)
		})
	}

	dispose(error: Error): void {
		if (this.stopped) return
		this.stopped = error
		for (const entry of this.queue.splice(0)) {
			this.removeAbortListeners(entry)
			entry.reject(error)
		}
	}

	private releaseOnce(): () => void {
		let pending = true
		return () => {
			if (!pending) return
			pending = false
			this.active -= 1
			this.dispatch()
		}
	}

	private dispatch(): void {
		if (this.stopped) return
		while (this.active < this.maxConcurrent) {
			const entry = this.queue.shift()
			if (!entry) return
			this.removeAbortListeners(entry)
			const aborted = entry.signals.find((signal) => signal.aborted)
			if (aborted) {
				entry.reject(abortError(aborted))
				continue
			}
			this.active += 1
			entry.resolve(this.releaseOnce())
		}
	}

	private removeAbortListeners(entry: QueueEntry): void {
		if (!entry.onAbort) return
		for (const signal of entry.signals) signal.removeEventListener('abort', entry.onAbort)
	}
}

function withRequestLifetime(
	options: WretchOptions,
	timeoutMs: number,
	signals: readonly (AbortSignal | undefined)[],
) {
	const sources = [options.signal, ...signals].filter(
		(signal): signal is AbortSignal => signal !== undefined,
	)
	if (sources.length === 0 && timeoutMs <= 0) return { options, dispose: () => {} }
	if (sources.length === 1 && timeoutMs <= 0)
		return { options: { ...options, signal: sources[0] }, dispose: () => {} }

	const controller = new AbortController()
	const listeners: Array<readonly [AbortSignal, () => void]> = []
	for (const signal of sources) {
		if (signal.aborted) {
			controller.abort(signal.reason)
			break
		}
		const onAbort = () => controller.abort(signal.reason)
		signal.addEventListener('abort', onAbort, { once: true })
		listeners.push([signal, onAbort])
	}
	const timer =
		timeoutMs > 0 && !controller.signal.aborted
			? setTimeout(
					() =>
						controller.abort(
							new DOMException(`Request timed out after ${timeoutMs}ms`, 'TimeoutError'),
						),
					timeoutMs,
				)
			: undefined
	return {
		options: { ...options, signal: controller.signal },
		dispose: () => {
			if (timer !== undefined) clearTimeout(timer)
			for (const [signal, listener] of listeners) signal.removeEventListener('abort', listener)
		},
	}
}

function httpUrl(input: string): URL {
	let url: URL
	try {
		url = new URL(input)
	} catch {
		throw new TypeError('Outbound request URL must be absolute')
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new TypeError('Outbound request URL must use HTTP or HTTPS')
	}
	return url
}

export type OutboundPolicy = {
	middleware(timeoutMs?: () => number, ownerSignal?: AbortSignal): ConfiguredMiddleware
	dispose(): void
}

export function createOutboundPolicy(config: WretchPluginConfig): OutboundPolicy {
	const scheduler = new RequestScheduler(config.maxConcurrentRequests, config.maxQueuedRequests)
	const allowedOrigins = new Set(config.allowedOrigins.map((value) => httpUrl(value).origin))
	const shutdown = new AbortController()
	let active = true
	const stopped = new Error('Wretch client belongs to a stopped or replaced plugin generation')

	return {
		middleware:
			(timeoutMs = () => config.timeoutMs, ownerSignal) =>
			(next) =>
			async (input, options) => {
				if (!active) throw stopped
				const url = httpUrl(input)
				if (allowedOrigins.size > 0 && !allowedOrigins.has(url.origin)) {
					throw new Error(`Outbound HTTP origin is not allowed: ${url.origin}`)
				}

				const lifecycleSignals = [ownerSignal, shutdown.signal]
				const release = await scheduler.acquire([options.signal, ...lifecycleSignals])
				const request = withRequestLifetime(options, timeoutMs(), lifecycleSignals)
				try {
					if (request.options.signal?.aborted) throw abortError(request.options.signal)
					return await next(url.href, request.options)
				} finally {
					request.dispose()
					release()
				}
			},
		dispose: () => {
			if (!active) return
			active = false
			scheduler.dispose(stopped)
			shutdown.abort(stopped)
		},
	}
}
