export class HostDevelopmentClosedError extends Error {
	readonly code = 'host_development_closed' as const
	constructor() {
		super('Host development session is closed')
		this.name = 'HostDevelopmentClosedError'
	}
}

export interface HostDevelopmentDriver {
	/** Admit a complete evaluate/prepare/commit/settle operation into this host's development lane. */
	enqueue<T>(operation: () => Promise<T>): Promise<T>
	/** Finite barrier: observes only operations admitted before this call. */
	settled(): Promise<void>
	/** Synchronously rejects new admission, then drains every previously accepted operation. */
	close(): Promise<void>
}

/** One serial lane shared by definition updates, source events, recovery and artifact refresh. */
export function createHostDevelopmentDriver(): HostDevelopmentDriver {
	let tail: Promise<void> = Promise.resolve()
	let closed = false
	return Object.freeze({
		enqueue<T>(operation: () => Promise<T>): Promise<T> {
			if (closed) return Promise.reject(new HostDevelopmentClosedError())
			const result = tail.then(operation)
			// A failed candidate rejects its caller without poisoning the next recovery attempt.
			tail = result.then(
				(): void => undefined,
				(): void => undefined,
			)
			return result
		},
		settled: () => tail,
		close() {
			closed = true
			return tail
		},
	})
}
