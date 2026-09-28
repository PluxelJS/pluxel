export interface SingleflightRunOptions {
	/** Cancel this caller's wait only. Shared work continues. */
	readonly signal?: AbortSignal
}

export interface Singleflight<Key, Value> {
	/** Share pending work for this key (Map equality). Completed results are not cached. */
	run(key: Key, options?: SingleflightRunOptions): Promise<Value>
	/** Stop admission and wait for shared work. Operation errors are reported by run, not close. */
	close(): Promise<void>
}

/** A run was requested after close began. */
export class SingleflightClosedError extends Error {
	constructor() {
		super('singleflight: cannot run after close')
		this.name = 'SingleflightClosedError'
	}
}

type Outcome<Value> = { ok: true; value: Value } | { ok: false; reason: unknown }
type Waiter<Value> = (outcome: Outcome<Value>) => void
interface Flight<Value> {
	promise: Promise<Value>
	waiters: Set<Waiter<Value>> | undefined
}

/**
 * Bind one operation and share only its pending calls by key. Operations start in a
 * microtask; cancelling a waiter never cancels shared work. The creator owns any
 * underlying cancellation through the operation's closure. close is idempotent,
 * drains accepted work, and may wait indefinitely for an operation that never settles.
 * An operation must not await its own key through this instance (a self-dependency).
 */
export function singleflight<Key, Result>(
	operation: (key: Key) => Result,
): Singleflight<Key, Awaited<Result>> {
	if (typeof operation !== 'function') {
		throw new TypeError('singleflight: operation must be a function')
	}
	const pending = new Map<Key, Flight<Awaited<Result>>>()
	let closing: Promise<void> | undefined

	function run(key: Key, options: SingleflightRunOptions = {}): Promise<Awaited<Result>> {
		if (closing) return Promise.reject(new SingleflightClosedError())
		const { signal } = options
		if (signal?.aborted) return Promise.reject(signal.reason)
		let flight = pending.get(key)
		if (!flight) {
			const promise = Promise.resolve().then(() => Promise.resolve(operation(key)))
			const created: Flight<Awaited<Result>> = { promise, waiters: undefined }
			flight = created
			pending.set(key, created)
			const settle = (outcome: Outcome<Awaited<Result>>) => {
				pending.delete(key)
				const waiters = created.waiters
				created.waiters = undefined
				if (waiters) {
					for (const waiter of waiters) waiter(outcome)
					waiters.clear()
				}
			}
			// One source subscription per flight. Cancelled waiters are removable,
			// unlike Promise reactions retained until the shared operation settles.
			void promise.then(
				(value) => settle({ ok: true, value }),
				(reason: unknown) => settle({ ok: false, reason }),
			)
		}
		if (!signal) return flight.promise
		const waiters = (flight.waiters ??= new Set())
		return new Promise<Awaited<Result>>((resolve, reject) => {
			const abort = () => {
				waiters.delete(waiter)
				signal.removeEventListener('abort', abort)
				reject(signal.reason)
			}
			const waiter: Waiter<Awaited<Result>> = (outcome) => {
				signal.removeEventListener('abort', abort)
				if (outcome.ok) resolve(outcome.value)
				else reject(outcome.reason)
			}
			waiters.add(waiter)
			signal.addEventListener('abort', abort, { once: true })
		})
	}

	function close(): Promise<void> {
		closing ??= Promise.allSettled(Array.from(pending.values(), (flight) => flight.promise)).then(
			() => undefined,
		)
		return closing
	}

	return Object.freeze({ run, close })
}
