export function matchesSpecifierPattern(specifier: string, pattern: string) {
	if (!pattern) return false
	if (pattern.endsWith('/*')) {
		const prefix = pattern.slice(0, -1) // keep trailing slash
		return specifier.startsWith(prefix)
	}
	return specifier === pattern || specifier.startsWith(`${pattern}/`)
}

type BatchDebounceReason = 'debounce' | 'maxwait' | 'maxbatch' | 'barrier'
const defaultBatchDebounceErrorHandler = (error: unknown) => {
	console.error('[pluxel:hmr] batch flush failed', error)
}

export class BatchDebouncer {
	private pending = new Set<string>()
	private t: NodeJS.Timeout | null = null
	private tMax: NodeJS.Timeout | null = null
	private epoch = 0
	private inFlight: Promise<void> = Promise.resolve()
	private inFlightCount = 0
	private closed = false
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

	/** Flushes the currently observed changes and captures their finite completion boundary. */
	flushObserved(): Promise<void> {
		this.flush('barrier')
		return this.inFlight
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
		if (this.closed) return
		this.pending.add(id)
		if (!this.t) this.t = setTimeout(() => this.flush('debounce'), this.debounceMs)
		if (!this.tMax) this.tMax = setTimeout(() => this.flush('maxwait'), this.maxWaitMs)
		if (this.pending.size >= this.maxBatchFiles) this.flush('maxbatch')
	}

	/** Stops admission, drops queued work, and waits for the active flush. */
	async close(): Promise<void> {
		if (this.closed) return this.inFlight
		this.closed = true
		this.clearTimers()
		this.pending.clear()
		await this.inFlight
		this.notifyIdle()
	}
	private flush(_reason: BatchDebounceReason) {
		if (this.pending.size === 0) return
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
		this.inFlight = this.inFlight.then(() => this.runFlush(files, epoch))
	}

	private async runFlush(files: string[], epoch: number): Promise<void> {
		try {
			// A flush already executing when close() starts is allowed to finish. Promise-chain
			// successors have not started yet and are discarded with the rest of queued work.
			if (this.closed) return
			await this.flushFn(files, epoch)
		} catch (error) {
			this.onError(error)
		} finally {
			this.inFlightCount = Math.max(0, this.inFlightCount - 1)
			this.notifyIdle()
		}
	}

	private notifyIdle() {
		if (!this.isIdle() || this.idleWaiters.size === 0) return
		const waiters = [...this.idleWaiters]
		for (const w of waiters) {
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
