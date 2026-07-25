export type RetryGateOptions = {
	now?: () => number
	delay?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/** Delays future work after a server-directed retry interval; it never replays work itself. */
export class RetryGate {
	private blockedUntil = 0
	private readonly now: () => number
	private readonly delay: (ms: number, signal?: AbortSignal) => Promise<void>

	constructor(options: RetryGateOptions = {}) {
		this.now = options.now ?? Date.now
		this.delay = options.delay ?? abortableDelay
	}

	blockFor(ms: number): void {
		if (!Number.isFinite(ms) || ms <= 0) return
		this.blockedUntil = Math.max(this.blockedUntil, this.now() + ms)
	}

	async wait(signal?: AbortSignal): Promise<void> {
		for (;;) {
			if (signal?.aborted) throw signal.reason
			const remaining = this.blockedUntil - this.now()
			if (remaining <= 0) return
			await this.delay(remaining, signal)
		}
	}
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(signal.reason)
	return new Promise((resolve, reject) => {
		const timer = setTimeout(finish, ms)
		function finish() {
			signal?.removeEventListener('abort', abort)
			resolve()
		}
		function abort() {
			clearTimeout(timer)
			reject(signal?.reason)
		}
		signal?.addEventListener('abort', abort, { once: true })
	})
}
