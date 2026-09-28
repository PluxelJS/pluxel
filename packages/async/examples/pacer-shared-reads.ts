import { RateLimiter } from '@tanstack/pacer'
import { singleflight, type SingleflightRunOptions } from '@pluxel/async/singleflight'

export type ReadResult<Value> =
	| { readonly kind: 'value'; readonly value: Value }
	| { readonly kind: 'rate-limited' }

/**
 * Optional application composition: Pacer owns a fixed time-window start budget;
 * singleflight owns shared work. Duplicate subscribers consume only one token.
 * Refusal is explicit, even when a successful read returns undefined. No queuing
 * or retries are added. A failed read still consumes its admission token.
 *
 * Per-call signal cancels only that subscriber. Capture an owner-controlled signal
 * in load if the underlying IO needs cancellation. close drains work before
 * releasing Pacer's window timers; it cannot force an uncooperative load to stop.
 */
export function createRateLimitedReads<Value>(
	load: (id: string) => Promise<Value>,
	options: { readonly limit: number; readonly windowMs: number },
) {
	const rate = new RateLimiter(() => {}, {
		limit: options.limit,
		window: options.windowMs,
		windowType: 'fixed',
	})
	const flights = singleflight<string, ReadResult<Value>>()
	let closing: Promise<void> | undefined

	return {
		read(id: string, runOptions?: SingleflightRunOptions): Promise<ReadResult<Value>> {
			return flights.run(
				id,
				async () => {
					// Synchronous boolean admission; IO results stay with their own task.
					if (!rate.maybeExecute()) return { kind: 'rate-limited' }
					return { kind: 'value', value: await load(id) }
				},
				runOptions,
			)
		},
		close(): Promise<void> {
			closing ??= flights.close().then(() => rate.reset())
			return closing
		},
	}
}
