import { sleep } from '../wait/index.js'

export interface RetryContext {
	/** One-based attempt number, including the initial call. */
	readonly attempt: number
	readonly signal: AbortSignal
}

export interface RetryOptions {
	/** Total allowed calls, including the initial attempt; a positive safe integer. */
	readonly attempts: number
	/** Explicitly authorize retrying this failure. Not called after exhaustion or cancellation. */
	readonly shouldRetry: (error: unknown, context: RetryContext) => boolean | PromiseLike<boolean>
	/** Initial delay in integer milliseconds; defaults to 100. */
	readonly delayMs?: number
	/** Backoff multiplier, finite and >= 1; defaults to 2. */
	readonly factor?: number
	/** Maximum delay in integer milliseconds; defaults to 30_000 and must be >= delayMs. */
	readonly maxDelayMs?: number
	/** Full jitter: uniformly choose an integer from 0 through the current delay. Defaults to false. */
	readonly jitter?: boolean
	readonly signal?: AbortSignal
}

/**
 * Retry sequentially with capped exponential backoff and an explicit failure predicate.
 * Exhaustion or denied retry preserves the task's original rejection, including non-Error values.
 * Abort interrupts backoff and prevents new attempts. An active task/predicate is awaited; task
 * success still succeeds and task failure after abort is preserved. Predicate errors propagate.
 * Delay bounds are 0..2_147_483_647; use a native timeout signal for an overall deadline.
 */
export async function retry<T>(
	task: (context: RetryContext) => T,
	options: RetryOptions,
): Promise<Awaited<T>> {
	const {
		attempts,
		shouldRetry,
		delayMs = 100,
		factor = 2,
		maxDelayMs = 30_000,
		jitter = false,
	} = options
	if (!Number.isSafeInteger(attempts) || attempts < 1) {
		throw new RangeError('attempts must be a positive safe integer including the initial attempt')
	}
	if (typeof task !== 'function') throw new TypeError('task must be a function')
	if (typeof shouldRetry !== 'function') throw new TypeError('shouldRetry must be a function')
	for (const [name, value] of [
		['delayMs', delayMs],
		['maxDelayMs', maxDelayMs],
	] as const) {
		if (!Number.isInteger(value) || value < 0 || value > 2_147_483_647) {
			throw new RangeError(`${name} must be an integer between 0 and 2147483647 milliseconds`)
		}
	}
	if (!Number.isFinite(factor) || factor < 1) throw new RangeError('factor must be finite and >= 1')
	if (maxDelayMs < delayMs) throw new RangeError('maxDelayMs must be >= delayMs')
	if (typeof jitter !== 'boolean') throw new TypeError('jitter must be a boolean')
	const signal = options.signal ?? new AbortController().signal
	let delay = delayMs
	for (let attempt = 1; ; attempt++) {
		signal.throwIfAborted()
		const context: RetryContext = { attempt, signal }
		try {
			return await task(context)
		} catch (error) {
			if (attempt === attempts || signal.aborted) throw error
			const allowed = await shouldRetry(error, context)
			if (typeof allowed !== 'boolean')
				throw new TypeError('shouldRetry must return a boolean', { cause: error })
			if (!allowed || signal.aborted) throw error
		}
		await sleep(jitter ? Math.floor(Math.random() * (Math.floor(delay) + 1)) : Math.floor(delay), {
			signal,
		})
		delay = Math.min(maxDelayMs, delay * factor)
	}
}
