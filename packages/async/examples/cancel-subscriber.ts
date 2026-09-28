import { singleflight } from '@pluxel/async/singleflight'

/** Two callers share a read; one can leave without cancelling the other's result. */
export async function cancelSubscriber() {
	const reads = singleflight<string, string>()
	const subscriber = new AbortController()
	let completeRead!: () => void
	const source = new Promise<string>((resolve) => {
		completeRead = () => resolve('Ada')
	})
	let calls = 0
	try {
		const first = reads.run(
			'profile:42',
			() => {
				calls++
				return source
			},
			{ signal: subscriber.signal },
		)
		const second = reads.run('profile:42', () => {
			throw new Error('A joined task must not execute')
		})
		// Observe both outcomes before cancellation. This signal belongs only to a subscriber.
		const outcomes = Promise.allSettled([first, second])
		subscriber.abort('view closed')
		completeRead()
		const settled = await outcomes
		return { calls, outcomes: settled }
	} finally {
		await reads.close()
	}
}
