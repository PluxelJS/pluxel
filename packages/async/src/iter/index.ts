/** Small, pull-based async iteration. No private stream protocol or runtime dependencies. */
export type Source<T> = Iterable<T> | AsyncIterable<T>

/** Skip one output without confusing valid undefined/null values with a filter decision. */
export const SKIP: unique symbol = Symbol('iter.skip')

export interface ConcurrentOptions {
	/** Required, finite, positive integer. Bounds all admitted-but-not-delivered items. */
	readonly concurrency: number
	/** Output order only; mapper side effects are never serialized. Default: input. */
	readonly order?: 'input' | 'completion'
	readonly signal?: AbortSignal
}

export interface MapContext {
	/** Zero-based position in the input, independent of output order and skipped values. */
	readonly index: number
	/** Aborted on upstream cancellation, failure, or early iterator close. */
	readonly signal: AbortSignal
}

function positiveInteger(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new RangeError(`iter: ${name} must be a positive safe integer`)
	}
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void
	const promise = new Promise<void>((yes) => {
		resolve = yes
	})
	return { promise, resolve }
}

function iteratorOf<T>(source: Source<T>): Iterator<T> | AsyncIterator<T> {
	const async = (source as AsyncIterable<T>)[Symbol.asyncIterator]
	const iterator = async == null ? (source as Iterable<T>)[Symbol.iterator]() : async.call(source)
	if (iterator == null || typeof iterator.next !== 'function') {
		throw new TypeError('iter: source must produce an iterator')
	}
	return iterator
}

function assertResult(value: unknown): void {
	if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
		throw new TypeError('iter: next() must produce an iterator result object')
	}
}

// Also close sync generators which yield a rejected Promise. Native for-await's
// async-from-sync adapter does not guarantee that generator cleanup on this path.
async function* valuesOf<T>(source: Source<T>): AsyncGenerator<Awaited<T>, void, unknown> {
	const iterator = iteratorOf(source)
	let done = false,
		failed = false
	try {
		while (true) {
			const item = await iterator.next()
			assertResult(item)
			if (item.done) {
				done = true
				return
			}
			yield await item.value
		}
	} catch (error) {
		failed = true
		throw error
	} finally {
		if (!done) {
			try {
				await iterator.return?.()
			} catch (error) {
				// Cleanup failures are observable only when they do not replace the primary failure.
				// oxlint-disable-next-line eslint/no-unsafe-finally -- Throwing here preserves cleanup failure only when no primary failure exists.
				if (!failed) throw error
			}
		}
	}
}

/**
 * Lazy, bounded, item-level concurrency over standard iterables.
 * Keep dependent operations for ONE item inside the mapper: one pool, no stage barriers.
 * Early close/error aborts cooperatively and drains started work before settling.
 * Native async-generator return() queues behind an outstanding next(); abort an
 * external signal to interrupt a pending pull, then await its settlement and close.
 */
export function mapConcurrent<T, R>(
	source: Source<T>,
	mapper: (
		value: Awaited<T>,
		context: MapContext,
	) => R | typeof SKIP | PromiseLike<R | typeof SKIP>,
	options: ConcurrentOptions,
): AsyncIterable<Exclude<Awaited<R>, typeof SKIP>> {
	// Snapshot configuration; later mutations must not alter an existing recipe.
	const { concurrency, order = 'input', signal: external } = options
	positiveInteger(concurrency, 'concurrency')
	if (order !== 'input' && order !== 'completion') throw new TypeError('iter: invalid order')
	if (typeof mapper !== 'function') throw new TypeError('iter: mapper must be a function')

	return {
		async *[Symbol.asyncIterator]() {
			external?.throwIfAborted()
			const iterator = iteratorOf(source)
			const controller = new AbortController()
			const active = new Set<Promise<void>>()
			const ready = new Map<number, Awaited<R> | typeof SKIP>()
			let changed: ReturnType<typeof deferred> | undefined
			let occupied = 0,
				nextIndex = 0,
				nextOutput = 0
			let stopped = false,
				sourceDone = false,
				finished = false,
				primaryError = false
			// A wrapper is necessary: rejection with undefined/null is still a failure.
			let failure: { reason: unknown } | undefined
			const waitForChange = (): Promise<void> => (changed ??= deferred()).promise
			const notify = (): void => {
				const waiter = changed
				changed = undefined
				waiter?.resolve()
			}
			const fail = (reason: unknown): void => {
				if (stopped) return
				failure = { reason }
				stopped = true
				controller.abort(reason)
				notify()
			}
			const abort = (): void => {
				fail(external?.reason)
			}
			external?.addEventListener('abort', abort, { once: true })
			// Iterator acquisition can run user code which aborts the external signal.
			if (external?.aborted) abort()

			// One producer serializes next() calls. It never waits for a mapper to finish.
			// It also never fills an unbounded result queue while the consumer is paused.
			const producer = (async (): Promise<void> => {
				try {
					while (!stopped) {
						if (occupied >= concurrency) {
							await waitForChange()
							continue
						}
						occupied++ // A pending upstream read reserves a slot too.
						const item = await iterator.next()
						assertResult(item)
						if (item.done) {
							occupied--
							sourceDone = true
							break
						}
						const index = nextIndex++
						// Attach rejection handling even when close races with a promised value.
						const job: Promise<void> = Promise.resolve(item.value)
							.then((value) =>
								stopped ? SKIP : mapper(value as Awaited<T>, { index, signal: controller.signal }),
							)
							.then(
								(value) => {
									active.delete(job)
									if (!stopped) {
										ready.set(index, value as Awaited<R> | typeof SKIP)
										notify()
									}
									return undefined
								},
								(error: unknown) => {
									active.delete(job)
									fail(error)
								},
							)
						// Native Promise reactions run after registration, including for synchronous inputs.
						active.add(job)
					}
				} catch (error) {
					fail(error)
				} finally {
					notify()
				}
			})()

			try {
				while (true) {
					if (failure) throw failure.reason
					const index = order === 'input' ? nextOutput : ready.keys().next().value
					if (index !== undefined && ready.has(index)) {
						const value = ready.get(index)!
						ready.delete(index)
						if (order === 'input') nextOutput++
						occupied--
						notify() // Delivery frees capacity, not mapper completion.
						if (value !== SKIP) yield value as Exclude<Awaited<R>, typeof SKIP>
					} else if (sourceDone && occupied === 0) {
						finished = true
						return
					} else {
						await waitForChange()
					}
				}
			} catch (error) {
				primaryError = true
				throw error
			} finally {
				stopped = true
				if (!finished && !controller.signal.aborted) {
					controller.abort(new DOMException('Iteration closed', 'AbortError'))
				}
				external?.removeEventListener('abort', abort)
				notify()
				// A source may be inside next(); do not race return() against that call.
				// Arbitrary non-cooperative next()/mapper promises cannot be force-cancelled.
				await producer
				await Promise.all(active)
				ready.clear()
				if (!sourceDone) {
					try {
						await iterator.return?.()
					} catch (error) {
						// Cleanup failures are observable only when they do not replace the primary failure.
						// oxlint-disable-next-line eslint/no-unsafe-finally -- Throwing here preserves cleanup failure only when no primary failure exists.
						if (!primaryError) throw error
					}
				}
			}
		},
	}
}

/** At most count outputs; closes upstream on early termination. Zero never opens it. */
export function take<T>(source: Source<T>, count: number): AsyncIterable<Awaited<T>> {
	if (!Number.isSafeInteger(count) || count < 0) {
		throw new RangeError('iter: count must be a non-negative safe integer')
	}
	return {
		async *[Symbol.asyncIterator]() {
			if (count === 0) return
			let seen = 0
			for await (const value of valuesOf(source)) {
				yield value
				if (++seen === count) return
			}
		},
	}
}

/** Contiguous batches, including a final partial batch; never reuses a yielded array. */
export function batch<T>(source: Source<T>, size: number): AsyncIterable<Awaited<T>[]> {
	positiveInteger(size, 'batch size')
	return {
		async *[Symbol.asyncIterator]() {
			let values: Awaited<T>[] = []
			for await (const value of valuesOf(source)) {
				values.push(value)
				if (values.length === size) {
					yield values
					values = []
				}
			}
			if (values.length > 0) yield values
		},
	}
}

/** Explicit materialization. The returned array necessarily uses O(number of outputs) memory. */
export async function toArray<T>(source: Source<T>): Promise<Awaited<T>[]> {
	const values: Awaited<T>[] = []
	for await (const value of valuesOf(source)) values.push(value)
	return values
}

/** Consume in delivery order without collecting results. Each callback is awaited. */
export async function forEach<T>(
	source: Source<T>,
	visit: (value: Awaited<T>, index: number) => unknown,
): Promise<void> {
	if (typeof visit !== 'function') throw new TypeError('iter: visit must be a function')
	let index = 0
	for await (const value of valuesOf(source)) await visit(value, index++)
}

/**
 * Find the first match in delivery order; close and drain upstream before returning.
 * Returns undefined if no match. A matching undefined value has the same result.
 */
export async function find<T>(
	source: Source<T>,
	predicate: (value: Awaited<T>, index: number) => boolean | PromiseLike<boolean>,
): Promise<Awaited<T> | undefined> {
	if (typeof predicate !== 'function') throw new TypeError('iter: predicate must be a function')
	let index = 0
	for await (const value of valuesOf(source)) {
		if (await predicate(value, index++)) return value
	}
	return undefined
}

/** True on the first match, including a matching undefined value. Empty source: false. */
export async function some<T>(
	source: Source<T>,
	predicate: (value: Awaited<T>, index: number) => boolean | PromiseLike<boolean>,
): Promise<boolean> {
	if (typeof predicate !== 'function') throw new TypeError('iter: predicate must be a function')
	let index = 0
	for await (const value of valuesOf(source)) {
		if (await predicate(value, index++)) return true
	}
	return false
}

/** False on the first non-match; close and drain upstream. Empty source: true. */
export async function every<T>(
	source: Source<T>,
	predicate: (value: Awaited<T>, index: number) => boolean | PromiseLike<boolean>,
): Promise<boolean> {
	if (typeof predicate !== 'function') throw new TypeError('iter: predicate must be a function')
	let index = 0
	for await (const value of valuesOf(source)) {
		if (!(await predicate(value, index++))) return false
	}
	return true
}

/** Sequential reduction in delivery order. An explicit initial value also defines the empty result. */
export async function reduce<T, R>(
	source: Source<T>,
	reducer: (
		accumulator: Awaited<R>,
		value: Awaited<T>,
		index: number,
	) => Awaited<R> | PromiseLike<Awaited<R>>,
	initial: R | PromiseLike<R>,
): Promise<Awaited<R>> {
	if (typeof reducer !== 'function') throw new TypeError('iter: reducer must be a function')
	let accumulator = await initial
	let index = 0
	for await (const value of valuesOf(source))
		accumulator = await reducer(accumulator, value, index++)
	return accumulator
}
