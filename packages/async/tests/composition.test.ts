import { test } from 'vitest'
import assert from 'node:assert/strict'
import { grfn } from '@pluxel/async/grfn'
import { mapConcurrent, toArray } from '@pluxel/async/iter'
import { deferred, tick } from './helpers.ts'

test('a drain-compiled graph keeps each mapper alive until its child work settles', async () => {
	const g = grfn<{ id: number; signal: AbortSignal }>()
	const started = deferred()
	const pending = deferred<number>()
	const error = new Error('One graph branch failed')
	const failed = g.task({}, () => {
		throw error
	})
	const other = g.task({ input: g.input }, async ({ input }) => {
		started.resolve()
		await pending.promise
		return input.id
	})
	const run = g.compile({ failed, other }, { failure: 'drain' })
	let returned = false
	const result = toArray(
		mapConcurrent([1], (id, { signal }) => run({ id, signal }), { concurrency: 1 }),
	).then(
		() => assert.fail('Expected rejection'),
		(reason) => {
			returned = true
			assert.equal(reason, error)
		},
	)
	await started.promise
	await tick()
	assert.equal(returned, false)
	pending.resolve(1)
	await result
})
