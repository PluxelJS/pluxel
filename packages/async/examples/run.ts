import { createProcessor } from './process-records.ts'
import { processSharedRecords } from './shared-requests.ts'
import { cancelSubscriber } from './cancel-subscriber.ts'
import { sleep } from '@pluxel/async/wait'

// Deterministic local adapters: no credentials, network, Plugin or Host required.
try {
	const batches: string[][] = []
	const processRecords = createProcessor({
		readRow: async (id, signal) => {
			signal.throwIfAborted()
			return { id, amount: Number(id) * 10 }
		},
		readMetadata: async (id, signal) => {
			signal.throwIfAborted()
			return { label: `row-${id}` }
		},
		writeBatch: async (records) => {
			batches.push(records.map(({ metadata }) => metadata.label))
		},
	})
	await processRecords(['1', '2', '3'], new AbortController().signal)
	console.log('process-records:', batches)

	const transient = new Error('temporary read failure')
	const attempts = new Map<string, number>()
	const saved: string[] = []
	await processSharedRecords(['a', 'a', 'b'], {
		signal: new AbortController().signal,
		read: async (id, signal) => {
			const attempt = (attempts.get(id) ?? 0) + 1
			attempts.set(id, attempt)
			await sleep(5, { signal })
			if (id === 'b' && attempt === 1) throw transient
			return id.toUpperCase()
		},
		shouldRetry: (error) => error === transient,
		save: async (record) => {
			saved.push(record)
		},
	})
	console.log('shared-requests:', { attempts: Object.fromEntries(attempts), saved })
	console.log('cancel-subscriber:', await cancelSubscriber())
} catch (error) {
	console.error('Example failed:', error)
	process.exitCode = 1
}
