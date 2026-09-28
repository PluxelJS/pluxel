import { limit } from '@pluxel/async/limit'
import { waitFor } from '@pluxel/async/wait'

/** A runnable, gated example: abandoning a caller's wait does not release its IO slot. */
export async function cancelWaitExample() {
	const requests = limit({ concurrency: 1 })
	const caller = new AbortController()
	const reason = new Error('Caller stopped waiting')
	let finishRead!: (value: number) => void
	const actualRead = new Promise<number>((resolve) => {
		finishRead = resolve
	})
	let notifyStarted!: () => void
	const started = new Promise<void>((resolve) => {
		notifyStarted = resolve
	})
	let secondStarted = false

	try {
		// The limiter owns the actual IO promise, even when that IO cannot be cancelled.
		const first = requests.run(() => {
			notifyStarted()
			return actualRead
		})
		const second = requests.run(() => {
			secondStarted = true
			return 2
		})
		// Keep waitFor outside run: it abandons only this caller's wait.
		const waiting = waitFor(first, { signal: caller.signal })
		await started
		caller.abort(reason)
		let cancelled = false
		try {
			await waiting
		} catch (error) {
			if (error !== reason) throw error
			cancelled = true
		}
		const whileCancelled = {
			cancelled,
			activeCount: requests.activeCount,
			pendingCount: requests.pendingCount,
			secondStarted,
		}

		// Only real IO completion releases the slot and admits the second operation.
		finishRead(1)
		const results = await Promise.all([first, second])
		return { whileCancelled, results }
	} finally {
		finishRead(1)
		await requests.close()
	}
}
