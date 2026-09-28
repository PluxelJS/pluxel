import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vitest'
import { sleep, until, waitFor } from '@pluxel/async/wait'
import { deferred, tick } from './helpers.ts'

afterEach(() => {
	vi.useRealTimers()
	vi.restoreAllMocks()
})

test('sleep clears its timer and abort listener on cancellation and completion', async () => {
	vi.useFakeTimers()
	const controller = new AbortController()
	const remove = vi.spyOn(controller.signal, 'removeEventListener')
	const reason = new Error('cancelled')
	const pending = sleep(100, { signal: controller.signal })
	const rejected = assert.rejects(pending, (error) => error === reason)
	controller.abort(reason)
	await rejected
	assert.equal(vi.getTimerCount(), 0)
	assert.equal(remove.mock.calls.length, 1)
	const completedController = new AbortController()
	const completedRemove = vi.spyOn(completedController.signal, 'removeEventListener')
	const completed = sleep(100, { signal: completedController.signal })
	await vi.advanceTimersByTimeAsync(100)
	await completed
	assert.equal(completedRemove.mock.calls.length, 1)
})

test('waitFor releases its listener, leaves source running, and observes late failure', async () => {
	const source = deferred<number>()
	const controller = new AbortController()
	const remove = vi.spyOn(controller.signal, 'removeEventListener')
	const reason = new Error('stop waiting')
	const result = waitFor(source.promise, { signal: controller.signal })
	controller.abort(reason)
	await assert.rejects(result, (error) => error === reason)
	assert.equal(remove.mock.calls.length, 1)
	source.reject(new Error('late source failure'))
	await tick()
	const aborted = AbortSignal.abort(reason)
	await assert.rejects(
		waitFor(Promise.reject('already failed'), { signal: aborted }),
		(error) => error === reason,
	)
	assert.equal(await waitFor(Promise.resolve(4)), 4)
})

test('waitFor observes thenable errors and removes listeners after ordinary settlement', async () => {
	const controller = new AbortController()
	const remove = vi.spyOn(controller.signal, 'removeEventListener')
	const error = new Error('then failed')
	const thenable = {
		// oxlint-disable-next-line unicorn/no-thenable -- Exercise supported PromiseLike assimilation.
		then() {
			throw error
		},
	}
	await assert.rejects(
		waitFor(thenable, { signal: controller.signal }),
		(reason) => reason === error,
	)
	assert.equal(remove.mock.calls.length, 1)
	assert.equal(await waitFor(Promise.resolve(3), { signal: controller.signal }), 3)
	assert.equal(remove.mock.calls.length, 2)
})

test('until checks immediately, waits after false, and never overlaps pending checks', async () => {
	vi.useFakeTimers()
	const first = deferred<boolean>()
	let calls = 0
	const result = until(() => (++calls === 1 ? first.promise : true), { intervalMs: 20 })
	assert.equal(calls, 1)
	await vi.advanceTimersByTimeAsync(100)
	assert.equal(calls, 1)
	first.resolve(false)
	await vi.advanceTimersByTimeAsync(19)
	assert.equal(calls, 1)
	await vi.advanceTimersByTimeAsync(1)
	await result
	assert.equal(calls, 2)
	assert.equal(vi.getTimerCount(), 0)
})

test('until drains a running check and preserves acquired success or failure after abort', async () => {
	for (const outcome of ['success', 'failure', 'false'] as const) {
		const controller = new AbortController()
		const pending = deferred<boolean>()
		const error = new Error('check failed')
		const reason = new Error('stop')
		let settled = false
		const result = until(
			({ signal }) => {
				assert.equal(signal, controller.signal)
				return pending.promise
			},
			{ intervalMs: 0, signal: controller.signal },
		)
		const observed = result.then(
			() => {
				settled = true
				return undefined
			},
			(failure) => {
				settled = true
				assert.equal(failure, outcome === 'failure' ? error : reason)
			},
		)
		controller.abort(reason)
		await tick()
		assert.equal(settled, false)
		if (outcome === 'failure') pending.reject(error)
		else pending.resolve(outcome === 'success')
		await observed
	}
})

test('wait bounds and invalid check results fail explicitly before further work', async () => {
	for (const value of [-1, 0.5, Infinity, NaN, 2_147_483_648]) {
		await assert.rejects(sleep(value), RangeError)
		await assert.rejects(
			until(() => assert.fail('must not run'), { intervalMs: value }),
			RangeError,
		)
	}
	const reason = new Error('pre-aborted')
	await assert.rejects(
		until(() => assert.fail('must not run'), { intervalMs: 1, signal: AbortSignal.abort(reason) }),
		(error) => error === reason,
	)
	await assert.rejects(
		until(
			() => {
				throw reason
			},
			{ intervalMs: 1 },
		),
		(error) => error === reason,
	)
	await assert.rejects(
		until(() => 'truthy' as never, { intervalMs: 1 }),
		TypeError,
	)
})

test('until snapshots delay policy before callbacks can mutate caller options', async () => {
	vi.useFakeTimers()
	const options = { intervalMs: 20 }
	let calls = 0
	const pending = until(() => {
		options.intervalMs = 1
		return ++calls === 2
	}, options)
	await vi.advanceTimersByTimeAsync(19)
	assert.equal(calls, 1)
	await vi.advanceTimersByTimeAsync(1)
	await pending
	await assert.rejects(until(undefined as never, { intervalMs: 0 }), TypeError)
})
