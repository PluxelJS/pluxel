/** A task was submitted after its limiter closed admission. */
export class LimiterClosedError extends Error {
	constructor() {
		super('limit: cannot submit work to a closed limiter')
		this.name = 'LimiterClosedError'
	}
}

export interface LimitOptions {
	/** Maximum running tasks; a positive safe integer. Queued work is not bounded. */
	readonly concurrency: number
}

export interface RunOptions {
	/** Cancels queued work; running work must cooperate and retains its slot until settled. */
	readonly signal?: AbortSignal
}

export interface TaskContext {
	readonly signal: AbortSignal
}

export interface Limiter {
	/** Live number of tasks holding a slot, including tasks scheduled to start. */
	readonly activeCount: number
	/** Live number of tasks waiting for a slot. */
	readonly pendingCount: number
	/** Admit lazy work in FIFO order. Callbacks start in a microtask, never inline. */
	run<T>(task: (context: TaskContext) => T, options?: RunOptions): Promise<Awaited<T>>
	/** Stop admission and wait for all admitted work, including queued work. Never rejects. */
	close(): Promise<void>
}

export interface KeyedLimiter<K> {
	/** Each key has an independent FIFO and concurrency budget. Keys use Map equality. */
	run<T>(key: K, task: (context: TaskContext) => T, options?: RunOptions): Promise<Awaited<T>>
	/** Stop admission across all keys and gracefully drain admitted work. Never rejects. */
	close(): Promise<void>
}

const idleSignal = new AbortController().signal

interface Pending {
	previous: Pending | undefined
	next: Pending | undefined
	start(): void
	removeAbortListener(): void
}

function validateConcurrency(concurrency: number): void {
	if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
		throw new RangeError('limit: concurrency must be a positive safe integer')
	}
}

function createLimiter(concurrency: number, onIdle: () => void): Limiter {
	let active = 0
	let pending = 0
	let head: Pending | undefined
	let tail: Pending | undefined
	let closed = false
	let closing: Promise<void> | undefined
	let resolveClose: (() => void) | undefined

	function unlink(node: Pending): void {
		if (node.previous) node.previous.next = node.next
		else head = node.next
		if (node.next) node.next.previous = node.previous
		else tail = node.previous
		node.previous = undefined
		node.next = undefined
		node.removeAbortListener()
		pending--
	}

	function checkIdle(): void {
		if (active === 0 && pending === 0) {
			onIdle()
			resolveClose?.()
		}
	}

	function finish(): void {
		active--
		if (head) {
			const next = head
			unlink(next)
			next.start()
		}
		checkIdle()
	}

	return {
		get activeCount() {
			return active
		},
		get pendingCount() {
			return pending
		},
		run<T>(task: (context: TaskContext) => T, options?: RunOptions): Promise<Awaited<T>> {
			if (closed) return Promise.reject(new LimiterClosedError())
			if (typeof task !== 'function')
				return Promise.reject(new TypeError('limit: task must be a function'))
			const signal = options?.signal ?? idleSignal
			if (signal.aborted) return Promise.reject(signal.reason)
			return new Promise<Awaited<T>>((resolve, reject) => {
				const start = () => {
					active++
					Promise.resolve()
						.then(() => {
							signal.throwIfAborted()
							return Promise.resolve(task({ signal }))
						})
						.then(
							(value) => {
								finish()
								return resolve(value)
							},
							(error: unknown) => {
								finish()
								return reject(error)
							},
						)
				}
				if (active < concurrency) {
					start()
					return
				}
				const abort = () => {
					unlink(node)
					reject(signal.reason)
					checkIdle()
				}
				const node: Pending = {
					previous: tail,
					next: undefined,
					start,
					removeAbortListener: () => signal.removeEventListener('abort', abort),
				}
				if (tail) tail.next = node
				else head = node
				tail = node
				pending++
				// The default signal never aborts and needs no per-task listeners.
				if (signal !== idleSignal) signal.addEventListener('abort', abort, { once: true })
			})
		},
		close() {
			if (!closing) {
				closed = true
				closing = new Promise<void>((resolve) => {
					resolveClose = resolve
				})
				checkIdle()
			}
			return closing
		},
	}
}

/**
 * Share a fixed concurrency budget across callers. Pending admission is unbounded;
 * use bounded iteration for large streams. Running failures/results remain unchanged
 * even if their signal aborts. Awaiting nested work on the same saturated limiter
 * or awaiting close() inside its task can deadlock. Repeated close calls return the same drain promise.
 */
export function limit(options: LimitOptions): Limiter {
	const { concurrency } = options
	validateConcurrency(concurrency)
	return createLimiter(concurrency, () => {})
}

/**
 * Independent per-key limits; there is no global concurrency cap. Idle keys are
 * released automatically. Every admitted call executes (this is not deduplication).
 */
export function keyedLimit<K>(options: LimitOptions): KeyedLimiter<K> {
	const { concurrency } = options
	validateConcurrency(concurrency)
	const keys = new Map<K, Limiter>()
	let closing: Promise<void> | undefined
	return {
		run(key, task, runOptions) {
			if (closing) return Promise.reject(new LimiterClosedError())
			if (typeof task !== 'function')
				return Promise.reject(new TypeError('limit: task must be a function'))
			if (runOptions?.signal?.aborted) return Promise.reject(runOptions.signal.reason)
			let queue = keys.get(key)
			if (!queue) {
				queue = createLimiter(concurrency, () => keys.delete(key))
				keys.set(key, queue)
			}
			return queue.run(task, runOptions)
		},
		close() {
			closing ??= Promise.all(Array.from(keys.values(), (queue) => queue.close())).then(
				() => undefined,
			)
			return closing
		},
	}
}
