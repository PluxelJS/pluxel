import { forEach, mapConcurrent } from '@pluxel/async/iter'
import { limit } from '@pluxel/async/limit'
import { retry } from '@pluxel/async/retry'
import { singleflight } from '@pluxel/async/singleflight'

/**
 * Stream IDs through a bounded window, share duplicate in-flight reads, and limit
 * individual attempts. The caller owns cancellation and decides which failures
 * are safe to retry. Every delivered occurrence is passed to save, in input order.
 */
export async function processSharedRecords<T>(
	ids: Iterable<string> | AsyncIterable<string>,
	options: {
		readonly signal: AbortSignal
		readonly read: (id: string, signal: AbortSignal) => Promise<T>
		readonly shouldRetry: (error: unknown) => boolean
		readonly save: (record: T) => Promise<void>
	},
): Promise<void> {
	const { signal, read, shouldRetry, save } = options
	const requests = limit({ concurrency: 4 })
	const reads = singleflight((id: string) =>
		retry(
			({ signal: attemptSignal }) =>
				requests.run(() => read(id, attemptSignal), { signal: attemptSignal }),
			{ attempts: 3, shouldRetry, signal },
		),
	)
	try {
		await forEach(
			mapConcurrent(ids, (id, context) => reads.run(id, { signal: context.signal }), {
				concurrency: 8,
				signal,
			}),
			save,
		)
	} finally {
		// Shared work may still make a later retry after a waiter leaves. Drain it
		// before closing the limiter that those retries still need to enter.
		await reads.close()
		await requests.close()
	}
}
