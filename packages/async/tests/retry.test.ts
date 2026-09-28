import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vitest'
import { retry, type RetryOptions } from '@pluxel/async/retry'
import { deferred, tick } from './helpers.ts'

afterEach(() => {
	vi.useRealTimers()
	vi.restoreAllMocks()
})

test('retry uses one-based attempts, capped backoff, and returns successful values', async () => {
	vi.useFakeTimers()
	const attempts: number[] = []
	const predicates: number[] = []
	const failure = new Error('temporary')
	const result = retry(
		({ attempt, signal }) => {
			assert.equal(signal.aborted, false)
			attempts.push(attempt)
			if (attempt < 4) throw failure
			return 42
		},
		{
			attempts: 4,
			delayMs: 10,
			maxDelayMs: 15,
			shouldRetry(error, { attempt }) {
				assert.equal(error, failure)
				predicates.push(attempt)
				return true
			},
		},
	)
	await vi.advanceTimersByTimeAsync(9)
	assert.deepEqual(attempts, [1])
	await vi.advanceTimersByTimeAsync(1)
	assert.deepEqual(attempts, [1, 2])
	await vi.advanceTimersByTimeAsync(15)
	assert.deepEqual(attempts, [1, 2, 3])
	await vi.advanceTimersByTimeAsync(15)
	assert.equal(await result, 42)
	assert.deepEqual(predicates, [1, 2, 3])
})

test('retry requires permission and preserves exhaustion including undefined rejection', async () => {
	vi.useFakeTimers()
	const denied = new Error('do not retry')
	await assert.rejects(
		retry(
			() => {
				throw denied
			},
			{ attempts: 3, shouldRetry: () => false },
		),
		(error) => error === denied,
	)
	let calls = 0
	const result = retry(
		() => {
			calls++
			return Promise.reject(undefined)
		},
		{ attempts: 2, delayMs: 0, shouldRetry: () => true },
	)
	const observed = result.then(
		() => assert.fail('expected rejection'),
		(error) => assert.equal(error, undefined),
	)
	await vi.runAllTimersAsync()
	await observed
	assert.equal(calls, 2)
	const predicateError = new Error('policy error')
	await assert.rejects(
		retry(
			() => {
				throw denied
			},
			{
				attempts: 3,
				shouldRetry: () => {
					throw predicateError
				},
			},
		),
		(error) => error === predicateError,
	)
})

test('abort clears backoff timer and never starts another attempt', async () => {
	vi.useFakeTimers()
	const controller = new AbortController()
	let calls = 0
	const reason = new Error('stop')
	const pending = retry(
		() => {
			calls++
			throw new Error('temporary')
		},
		{ attempts: 3, signal: controller.signal, shouldRetry: () => true },
	)
	const observed = assert.rejects(pending, (error) => error === reason)
	await vi.advanceTimersByTimeAsync(0)
	assert.equal(vi.getTimerCount(), 1)
	controller.abort(reason)
	await observed
	assert.equal(vi.getTimerCount(), 0)
	assert.equal(calls, 1)
})

test('retry awaits an active task after abort, preserving its actual result', async () => {
	for (const fails of [false, true]) {
		const controller = new AbortController()
		const task = deferred<number>()
		const error = new Error('actual failure')
		let settled = false
		const result = retry(
			({ signal }) => {
				assert.equal(signal, controller.signal)
				return task.promise
			},
			{
				attempts: 3,
				signal: controller.signal,
				shouldRetry: () => assert.fail('no retry after abort'),
			},
		)
		const observed = result.then(
			(value) => {
				settled = true
				return assert.equal(value, 7)
			},
			(reason) => {
				settled = true
				assert.equal(reason, error)
			},
		)
		controller.abort()
		await tick()
		assert.equal(settled, false)
		if (fails) task.reject(error)
		else task.resolve(7)
		await observed
	}
})

test('abort during asynchronous retry predicate preserves task failure and stops retry', async () => {
	const controller = new AbortController()
	const predicate = deferred<boolean>()
	const started = deferred()
	const error = new Error('task failed')
	const pending = retry(
		() => {
			throw error
		},
		{
			attempts: 3,
			signal: controller.signal,
			shouldRetry: () => {
				started.resolve()
				return predicate.promise
			},
		},
	)
	await started.promise
	controller.abort()
	predicate.resolve(true)
	await assert.rejects(pending, (reason) => reason === error)
})

test('full jitter samples a bounded integer delay', async () => {
	vi.useFakeTimers()
	vi.spyOn(Math, 'random').mockReturnValue(0.5)
	let calls = 0
	const pending = retry(
		() => {
			if (++calls === 1) throw new Error('retry')
			return 9
		},
		{ attempts: 2, delayMs: 10, jitter: true, shouldRetry: () => true },
	)
	await vi.advanceTimersByTimeAsync(4)
	assert.equal(calls, 1)
	await vi.advanceTimersByTimeAsync(1)
	assert.equal(await pending, 9)
})

test('invalid retry options fail before executing work; pre-abort also prevents work', async () => {
	const valid: RetryOptions = { attempts: 2, shouldRetry: () => true }
	for (const invalid of [
		{ attempts: 0 },
		{ attempts: 1.5 },
		{ attempts: Infinity },
		{ attempts: Number.MAX_SAFE_INTEGER + 1 },
		{ delayMs: -1 },
		{ delayMs: 0.5 },
		{ maxDelayMs: 2_147_483_648 },
		{ maxDelayMs: 1 },
		{ factor: 0.5 },
		{ factor: Infinity },
		{ shouldRetry: undefined },
		{ jitter: 'yes' },
	]) {
		await assert.rejects(
			retry(() => assert.fail('must not run'), { ...valid, ...invalid } as RetryOptions),
		)
	}
	const reason = new Error('pre-aborted')
	await assert.rejects(
		retry(() => assert.fail('must not run'), { ...valid, signal: AbortSignal.abort(reason) }),
		(error) => error === reason,
	)
	await assert.rejects(
		retry(
			() => {
				throw reason
			},
			{ ...valid, shouldRetry: () => 'yes' as never },
		),
		TypeError,
	)
})

test('invalid task is not a retriable failure and thenable results follow promise semantics', async () => {
	await assert.rejects(
		retry(undefined as never, {
			attempts: 2,
			shouldRetry: () => assert.fail('invalid callbacks cannot be retried'),
		}),
		TypeError,
	)
	const failure = new Error('thenable failed')
	const thenable = {
		// oxlint-disable-next-line unicorn/no-thenable -- Exercise supported PromiseLike assimilation.
		then() {
			throw failure
		},
	}
	await assert.rejects(
		retry(() => thenable, {
			attempts: 1,
			shouldRetry: () => assert.fail('exhausted attempts skip retry policy'),
		}),
		(error) => error === failure,
	)
})

test('backoff stays bounded when multiplication overflows and keeps zero delay at zero', async () => {
	vi.useFakeTimers()
	const timers = vi.spyOn(globalThis, 'setTimeout')
	for (const delayMs of [0, 10]) {
		timers.mockClear()
		let calls = 0
		const result = retry(
			() => {
				if (++calls < 3) throw new Error('temporary')
				return 42
			},
			{
				attempts: 3,
				delayMs,
				maxDelayMs: 1000,
				factor: Number.MAX_VALUE,
				shouldRetry: () => true,
			},
		)
		await vi.runAllTimersAsync()
		assert.equal(await result, 42)
		assert.deepEqual(
			timers.mock.calls.map(([, delay]) => delay),
			[delayMs, delayMs === 0 ? 0 : 1000],
		)
	}
})
