/** Options for a wait that can be cancelled independently of its source. */
export interface WaitOptions {
	readonly signal?: AbortSignal
}

/** Context passed to a condition check. */
export interface WaitContext {
	readonly signal: AbortSignal
}

export interface UntilOptions extends WaitOptions {
	/** Delay after each false result, in integer milliseconds (0..2_147_483_647). */
	readonly intervalMs: number
}

/** Wait for an integer number of milliseconds (0..2_147_483_647). Abort clears the timer. */
export async function sleep(ms: number, options: WaitOptions = {}): Promise<void> {
	validateDelay(ms, 'ms')
	const { signal } = options
	signal?.throwIfAborted()
	return new Promise<void>((resolve, reject) => {
		const cleanup = () => signal?.removeEventListener('abort', abort)
		const timer = setTimeout(() => {
			cleanup()
			resolve()
		}, ms)
		const abort = () => {
			clearTimeout(timer)
			cleanup()
			reject(signal!.reason)
		}
		signal?.addEventListener('abort', abort, { once: true })
	})
}

/**
 * Cancel only the wait, never the supplied operation. A late source rejection remains observed.
 * An already-aborted signal wins even when the supplied promise has already settled.
 */
export function waitFor<T>(
	promise: PromiseLike<T>,
	options: WaitOptions = {},
): Promise<Awaited<T>> {
	const source = Promise.resolve(promise)
	const { signal } = options
	if (!signal) return source
	return new Promise<Awaited<T>>((resolve, reject) => {
		const cleanup = () => signal.removeEventListener('abort', abort)
		const abort = () => {
			cleanup()
			reject(signal.reason)
		}
		source.then(
			(value) => {
				cleanup()
				return resolve(value)
			},
			(error: unknown) => {
				cleanup()
				reject(error)
			},
		)
		if (signal.aborted) abort()
		else signal.addEventListener('abort', abort, { once: true })
	})
}

/**
 * Check immediately, then delay after each false result. Checks never overlap; thrown errors propagate.
 * Abort interrupts the delay and prevents new checks. An active check is awaited: true still succeeds,
 * an error is preserved, and false after abort rejects with the abort reason.
 */
export async function until(
	check: (context: WaitContext) => boolean | PromiseLike<boolean>,
	options: UntilOptions,
): Promise<void> {
	const { intervalMs, signal: suppliedSignal } = options
	validateDelay(intervalMs, 'intervalMs')
	if (typeof check !== 'function') throw new TypeError('check must be a function')
	const signal = suppliedSignal ?? new AbortController().signal
	const context: WaitContext = { signal }
	while (true) {
		signal.throwIfAborted()
		const ready = await check(context)
		if (typeof ready !== 'boolean') throw new TypeError('until check must return a boolean')
		if (ready) return
		await sleep(intervalMs, { signal })
	}
}

function validateDelay(value: number, name: string): void {
	if (!Number.isInteger(value) || value < 0 || value > 2_147_483_647) {
		throw new RangeError(`${name} must be an integer between 0 and 2147483647 milliseconds`)
	}
}
