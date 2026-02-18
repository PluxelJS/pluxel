import { existsSync } from 'node:fs'
import { getLogger } from '@logtape/logtape'
import { pluxelCategories } from '@pluxel/core/logger'
import { dirname, isAbsolute, resolve } from 'pathe'
import { normalizePath } from 'vite'
import { boundedSet, resolveCacheLimit } from '../shared/cache'

const nsToMs = (ns: bigint) => Number(ns) / 1e6

let pkgrootCacheLimit = 2_000
const pkgRootCache = new Map<string, string | null>()

export function setPkgrootCacheLimit(raw: unknown) {
	pkgrootCacheLimit = resolveCacheLimit(raw, 2_000)
	if (pkgrootCacheLimit <= 0) pkgRootCache.clear()
}

export const findNearestPackageRoot = (start: string): string | null => {
	try {
		let current = normalizePath(start)
		if (pkgrootCacheLimit > 0) {
			const cached = pkgRootCache.get(current)
			if (cached !== undefined) return cached
		}

		const visited: string[] = []
		while (true) {
			visited.push(current)

			if (pkgrootCacheLimit > 0) {
				const cached = pkgRootCache.get(current)
				if (cached !== undefined) {
					for (const dir of visited) boundedSet(pkgRootCache, dir, cached, pkgrootCacheLimit)
					return cached
				}
			}

			if (existsSync(resolve(current, 'package.json'))) {
				const root = normalizePath(current)
				for (const dir of visited) boundedSet(pkgRootCache, dir, root, pkgrootCacheLimit)
				return root
			}
			const parent = dirname(current)
			if (parent === current) {
				for (const dir of visited) boundedSet(pkgRootCache, dir, null, pkgrootCacheLimit)
				return null
			}
			current = parent
		}
	} catch {
		return null
	}
}

export const startTimer = () => {
	const t0 = process.hrtime.bigint()
	return () => nsToMs(process.hrtime.bigint() - t0)
}

export function matchesSpecifierPattern(specifier: string, pattern: string) {
	if (!pattern) return false
	if (pattern.endsWith('/*')) {
		const prefix = pattern.slice(0, -1) // keep trailing slash
		return specifier.startsWith(prefix)
	}
	return specifier === pattern || specifier.startsWith(`${pattern}/`)
}

export function resolveGlobPatterns(
	patterns: readonly string[] | undefined,
	cwd: string,
): string[] | undefined {
	if (!patterns?.length) return undefined
	return patterns.map((pattern) => {
		const negated = pattern.startsWith('!')
		const raw = negated ? pattern.slice(1) : pattern
		const normalized = isAbsolute(raw) ? normalizePath(raw) : normalizePath(resolve(cwd, raw))
		return negated ? `!${normalized}` : normalized
	})
}

type BatchDebounceReason = 'debounce' | 'maxwait' | 'maxbatch'
const batchDebouncerLogger = getLogger([...pluxelCategories.hmr, 'BatchDebouncer'])
const defaultBatchDebounceErrorHandler = (error: unknown) => {
	batchDebouncerLogger.error('flush failed', { error })
}

export class BatchDebouncer {
	private pending = new Set<string>()
	private t: NodeJS.Timeout | null = null
	private tMax: NodeJS.Timeout | null = null
	private epoch = 0
	private inFlight: Promise<void> = Promise.resolve()
	private inFlightCount = 0
	private idleWaiters = new Set<{
		resolve: () => void
		reject: (error: unknown) => void
		cleanup: () => void
	}>()
	constructor(
		private flushFn: (files: string[], epoch: number) => Promise<void>,
		private debounceMs: number,
		private maxWaitMs: number,
		private maxBatchFiles: number,
		private readonly onError: (error: unknown) => void = defaultBatchDebounceErrorHandler,
	) {}

	isIdle() {
		return (
			this.pending.size === 0 && this.t === null && this.tMax === null && this.inFlightCount === 0
		)
	}

	waitForIdle(options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<void> {
		if (this.isIdle()) return Promise.resolve()

		const timeoutMs =
			typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
				? Math.max(0, Math.floor(options.timeoutMs))
				: 30_000

		return new Promise<void>((resolve, reject) => {
			let timeout: NodeJS.Timeout | undefined
			let waiter: {
				resolve: () => void
				reject: (error: unknown) => void
				cleanup: () => void
			} | null = null

			const cleanup = () => {
				if (timeout) clearTimeout(timeout)
				timeout = undefined
				if (waiter) this.idleWaiters.delete(waiter)
				waiter = null
				if (typeof options.signal?.removeEventListener === 'function' && onAbort) {
					options.signal.removeEventListener('abort', onAbort)
				}
			}

			const onAbort =
				options.signal && typeof options.signal === 'object'
					? () => {
							cleanup()
							reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }))
						}
					: null

			if (options.signal?.aborted) {
				cleanup()
				reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }))
				return
			}
			if (onAbort) options.signal.addEventListener('abort', onAbort, { once: true })

			if (timeoutMs > 0) {
				timeout = setTimeout(() => {
					cleanup()
					reject(
						Object.assign(new Error('Timed out waiting for idle debouncer'), {
							name: 'HmrIdleTimeoutError',
						}),
					)
				}, timeoutMs)
			}

			waiter = {
				resolve: () => {
					cleanup()
					resolve()
				},
				reject: (error) => {
					cleanup()
					reject(error)
				},
				cleanup,
			}
			this.idleWaiters.add(waiter)

			// Re-check after registering to avoid races.
			if (this.isIdle()) {
				waiter.resolve()
			}
		})
	}

	push(id: string) {
		this.pending.add(id)
		if (!this.t) this.t = setTimeout(() => this.flush('debounce'), this.debounceMs)
		if (!this.tMax) this.tMax = setTimeout(() => this.flush('maxwait'), this.maxWaitMs)
		if (this.pending.size >= this.maxBatchFiles) this.flush('maxbatch')
	}
	private flush(_reason: BatchDebounceReason) {
		if (!this.pending.size) return
		this.clearTimers()
		const files = [...this.pending]
		this.pending.clear()
		const epoch = ++this.epoch
		this.enqueueFlush(files, epoch)
	}
	private clearTimers() {
		if (this.t) {
			clearTimeout(this.t)
			this.t = null
		}
		if (this.tMax) {
			clearTimeout(this.tMax)
			this.tMax = null
		}
	}
	private enqueueFlush(files: string[], epoch: number) {
		this.inFlightCount++
		this.inFlight = this.inFlight.then(async () => {
			try {
				await this.flushFn(files, epoch)
			} catch (error) {
				this.onError(error)
			} finally {
				this.inFlightCount = Math.max(0, this.inFlightCount - 1)
				this.notifyIdle()
			}
		})
	}

	private notifyIdle() {
		if (!this.isIdle() || this.idleWaiters.size === 0) return
		for (const w of [...this.idleWaiters]) {
			try {
				w.resolve()
			} catch {
				// ignore
			}
		}
	}
}

export class AsyncSerialLock {
	private tail: Promise<void> = Promise.resolve()

	async run<T>(fn: () => Promise<T>): Promise<T> {
		const prev = this.tail
		let release: (() => void) | undefined
		this.tail = new Promise<void>((r) => {
			release = r
		})
		await prev
		try {
			return await fn()
		} finally {
			release?.()
		}
	}
}
