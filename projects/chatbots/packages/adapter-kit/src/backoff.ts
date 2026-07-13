export type ExponentialBackoffOptions = {
	initialMs?: number
	maxMs?: number
	factor?: number
	jitter?: number
	random?: () => number
}

/** Stateful timing policy only; connection ownership remains in each adapter. */
export class ExponentialBackoff {
	private readonly initialMs: number
	private readonly maxMs: number
	private readonly factor: number
	private readonly jitter: number
	private readonly random: () => number
	private currentMs: number

	constructor(options: ExponentialBackoffOptions = {}) {
		this.initialMs = options.initialMs ?? 1_000
		this.maxMs = options.maxMs ?? 30_000
		this.factor = options.factor ?? 2
		this.jitter = options.jitter ?? 0.2
		this.random = options.random ?? Math.random
		if (!Number.isFinite(this.initialMs) || this.initialMs < 0)
			throw new Error('Backoff initialMs must be non-negative')
		if (!Number.isFinite(this.maxMs) || this.maxMs < this.initialMs)
			throw new Error('Backoff maxMs must be at least initialMs')
		if (!Number.isFinite(this.factor) || this.factor < 1)
			throw new Error('Backoff factor must be at least 1')
		if (!Number.isFinite(this.jitter) || this.jitter < 0 || this.jitter > 1)
			throw new Error('Backoff jitter must be between 0 and 1')
		this.currentMs = this.initialMs
	}

	next(): number {
		const variation = 1 + this.jitter * (this.random() * 2 - 1)
		const delay = Math.round(Math.min(this.maxMs, this.currentMs * variation))
		this.currentMs = Math.min(this.maxMs, this.currentMs * this.factor)
		return delay
	}

	reset(): void {
		this.currentMs = this.initialMs
	}
}

export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.reject(signal.reason)
	return new Promise((resolve, reject) => {
		const timer = setTimeout(finish, ms)
		function finish() {
			signal.removeEventListener('abort', abort)
			resolve()
		}
		function abort() {
			clearTimeout(timer)
			reject(signal.reason)
		}
		signal.addEventListener('abort', abort, { once: true })
	})
}
