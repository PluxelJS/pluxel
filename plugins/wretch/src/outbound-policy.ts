import type { ConfiguredMiddleware, WretchOptions } from 'wretch'
import type { WretchPluginConfig } from './config.ts'

type QueueEntry = {
	resolve: (release: () => void) => void
	reject: (error: Error) => void
	signal?: AbortSignal
	onAbort?: () => void
}

function abortError(signal?: AbortSignal): Error {
	if (signal?.reason instanceof Error) return signal.reason
	return new DOMException('The request was aborted', 'AbortError')
}

class RequestScheduler {
	private active = 0
	private readonly queue: QueueEntry[] = []

	constructor(
		private readonly maxConcurrent: number,
		private readonly maxQueued: number,
	) {}

	acquire(signal?: AbortSignal): Promise<() => void> {
		if (signal?.aborted) return Promise.reject(abortError(signal))
		if (this.active < this.maxConcurrent) {
			this.active += 1
			return Promise.resolve(this.releaseOnce())
		}
		if (this.queue.length >= this.maxQueued) {
			return Promise.reject(new Error('Outbound HTTP request queue is full'))
		}

		return new Promise((resolve, reject) => {
			const entry: QueueEntry = { resolve, reject, signal }
			if (signal) {
				entry.onAbort = () => {
					const index = this.queue.indexOf(entry)
					if (index >= 0) this.queue.splice(index, 1)
					reject(abortError(signal))
				}
				signal.addEventListener('abort', entry.onAbort, { once: true })
			}
			this.queue.push(entry)
		})
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
		while (this.active < this.maxConcurrent) {
			const entry = this.queue.shift()
			if (!entry) return
			if (entry.onAbort) entry.signal?.removeEventListener('abort', entry.onAbort)
			if (entry.signal?.aborted) {
				entry.reject(abortError(entry.signal))
				continue
			}
			this.active += 1
			entry.resolve(this.releaseOnce())
		}
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

function withTimeout(
	options: WretchOptions,
	timeoutMs: number,
): {
	options: WretchOptions
	dispose: () => void
} {
	if (timeoutMs <= 0) return { options, dispose: () => {} }
	const upstream = options.signal
	const controller = new AbortController()
	const abort = () => controller.abort(upstream?.reason)
	if (upstream?.aborted) abort()
	else upstream?.addEventListener('abort', abort, { once: true })
	const timer = setTimeout(
		() =>
			controller.abort(new DOMException(`Request timed out after ${timeoutMs}ms`, 'TimeoutError')),
		timeoutMs,
	)
	return {
		options: { ...options, signal: controller.signal },
		dispose: () => {
			clearTimeout(timer)
			upstream?.removeEventListener('abort', abort)
		},
	}
}

export type OutboundPolicy = {
	middleware(timeoutMs?: () => number): ConfiguredMiddleware
}

export function createOutboundPolicy(config: WretchPluginConfig): OutboundPolicy {
	const scheduler = new RequestScheduler(config.maxConcurrentRequests, config.maxQueuedRequests)
	const allowedOrigins = new Set(config.allowedOrigins.map((value) => httpUrl(value).origin))

	return {
		middleware:
			(timeoutMs = () => config.timeoutMs) =>
			(next) =>
			async (input, options) => {
				const url = httpUrl(input)
				if (allowedOrigins.size > 0 && !allowedOrigins.has(url.origin)) {
					throw new Error(`Outbound HTTP origin is not allowed: ${url.origin}`)
				}

				const release = await scheduler.acquire(options.signal)
				const request = withTimeout(options, timeoutMs())
				try {
					return await next(url.href, request.options)
				} finally {
					request.dispose()
					release()
				}
			},
	}
}
