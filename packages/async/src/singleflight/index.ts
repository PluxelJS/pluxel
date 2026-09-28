export interface SingleflightRunOptions {
	/** Cancel this caller's wait only. Shared work continues. */
	readonly signal?: AbortSignal
}

export interface Singleflight<Key, Value> {
	/** Number of pending keys, including tasks scheduled to start. */
	readonly size: number
	/**
	 * Share pending work for this key (Map equality). The first task wins; later
	 * callbacks for that key are not executed. Completed results are not cached.
	 */
	run(
		key: Key,
		task: () => Value | PromiseLike<Value>,
		options?: SingleflightRunOptions,
	): Promise<Awaited<Value>>
	/** Observe pending work without starting it. Available during close until settled. */
	get(key: Key): Promise<Awaited<Value>> | undefined
	/** Wait for a snapshot of current work; later calls are excluded. Never rejects. */
	drain(): Promise<void>
	/** Stop admission and drain. Idempotent; task errors belong to run/get, not close. */
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
 * Share pending work by key within one fixed result domain. The first task starts
 * in a microtask; cancelling a waiter never cancels shared work. Task closures own
 * underlying cancellation. drain snapshots current tasks; close first stops admission.
 * Neither drain nor close cancels work or throws task errors, and both can wait
 * indefinitely for a task that never settles. A task must not await its own key,
 * drain, or close through this instance (a self-dependency).
 */
export function singleflight<Key, Value>(): Singleflight<Key, Value> {
	const pending = new Map<Key, Flight<Awaited<Value>>>()
	let closed = false
	let closing: Promise<void> | undefined

	function run(
		key: Key,
		task: () => Value | PromiseLike<Value>,
		options: SingleflightRunOptions = {},
	): Promise<Awaited<Value>> {
		if (closed) return Promise.reject(new SingleflightClosedError())
		if (typeof task !== 'function')
			return Promise.reject(new TypeError('singleflight: task must be a function'))
		const { signal } = options
		if (signal?.aborted) return Promise.reject(signal.reason)
		let flight = pending.get(key)
		if (!flight) {
			const promise = Promise.resolve().then(() => Promise.resolve(task()))
			const created: Flight<Awaited<Value>> = { promise, waiters: undefined }
			flight = created
			pending.set(key, created)
			const settle = (outcome: Outcome<Awaited<Value>>) => {
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
		return new Promise<Awaited<Value>>((resolve, reject) => {
			const abort = () => {
				waiters.delete(waiter)
				signal.removeEventListener('abort', abort)
				reject(signal.reason)
			}
			const waiter: Waiter<Awaited<Value>> = (outcome) => {
				signal.removeEventListener('abort', abort)
				if (outcome.ok) resolve(outcome.value)
				else reject(outcome.reason)
			}
			waiters.add(waiter)
			signal.addEventListener('abort', abort, { once: true })
		})
	}

	function drain(): Promise<void> {
		return Promise.allSettled(Array.from(pending.values(), (flight) => flight.promise)).then(
			() => undefined,
		)
	}

	function close(): Promise<void> {
		if (!closing) {
			closed = true
			closing = drain()
		}
		return closing
	}

	return Object.freeze({
		get size() {
			return pending.size
		},
		run,
		get(key: Key) {
			return pending.get(key)?.promise
		},
		drain,
		close,
	})
}
