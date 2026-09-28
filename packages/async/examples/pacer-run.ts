import { createRateLimitedReads } from './pacer-shared-reads.ts'

let finishRead!: (value: string) => void
const source = new Promise<string>((resolve) => {
	finishRead = resolve
})
let calls = 0
const reader = createRateLimitedReads(
	async () => {
		calls++
		return source
	},
	{ limit: 1, windowMs: 1000 },
)
try {
	const subscriber = new AbortController()
	const first = reader.read('a', { signal: subscriber.signal })
	const second = reader.read('a')
	const outcomes = Promise.allSettled([first, second])
	console.log('different-key:', await reader.read('b'))
	subscriber.abort('view closed')
	finishRead('A')
	console.dir({ example: 'shared-read', calls, outcomes: await outcomes }, { depth: null })
} catch (error) {
	console.error('Pacer example failed:', error)
	process.exitCode = 1
} finally {
	finishRead('A')
	await reader.close()
}
