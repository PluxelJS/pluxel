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

// The example exercises public entries together and owns the dependency-close order.
test('shared reads survive a consumer failure and finish retrying before limiter close', async () => {
	const { processSharedRecords } = await import('../examples/shared-requests.ts')
	const transient = new Error('transient')
	const saveFailure = new Error('save failed')
	const first = deferred<string>()
	const other = deferred<string>()
	const seen: string[] = []
	const attempts: string[] = []
	let finished = false
	const result = processSharedRecords(['a', 'a', 'b'], {
		signal: new AbortController().signal,
		read: (id) => {
			attempts.push(id)
			if (id === 'a') return first.promise
			return attempts.filter((key) => key === 'b').length === 1
				? other.promise
				: Promise.resolve('b')
		},
		shouldRetry: (error) => error === transient,
		save: async (value) => {
			seen.push(value)
			throw saveFailure
		},
	}).then(
		() => assert.fail('Expected save failure'),
		(error) => {
			finished = true
			assert.equal(error, saveFailure)
		},
	)
	await tick()
	assert.deepEqual(attempts, ['a', 'b'])
	first.resolve('a')
	await tick()
	assert.equal(finished, false)
	other.reject(transient)
	await result
	assert.deepEqual(attempts, ['a', 'b', 'b'])
	assert.deepEqual(seen, ['a'])
})

test('cancelling an independent wait keeps the IO slot until real completion', async () => {
	const { cancelWaitExample } = await import('../examples/cancel-wait.ts')
	const { whileCancelled, results } = await cancelWaitExample()
	assert.deepEqual(whileCancelled, {
		cancelled: true,
		activeCount: 1,
		pendingCount: 1,
		secondStarted: false,
	})
	assert.deepEqual(results, [1, 2])
})
