import assert from 'node:assert/strict'
import { test, vi } from 'vitest'
import { AsyncDebouncer } from '@tanstack/pacer'
import { singleflight, SingleflightClosedError } from '@pluxel/async/singleflight'
import { createRateLimitedReads } from '../examples/pacer-shared-reads.ts'
import { deferred } from './helpers.ts'

test('shared reads consume one token, preserve undefined, and isolate subscriber cancellation', async () => {
	vi.useFakeTimers()
	const gate = deferred<undefined>()
	const started = deferred()
	const calls: string[] = []
	const reads = createRateLimitedReads(
		async (id) => {
			calls.push(id)
			started.resolve()
			return gate.promise
		},
		{ limit: 1, windowMs: 60_000 },
	)
	try {
		const controller = new AbortController()
		const reason = new Error('subscriber left')
		const first = reads.read('a', { signal: controller.signal })
		const second = reads.read('a')
		const cancelled = assert.rejects(first, (error) => error === reason)
		await started.promise
		assert.deepEqual(await reads.read('b'), { kind: 'rate-limited' })
		controller.abort(reason)
		await cancelled
		assert.deepEqual(calls, ['a'])
		const closing = reads.close()
		assert.equal(reads.close(), closing)
		assert.ok(
			vi.getTimerCount() > 0,
			'close must not reset the time window before shared work drains',
		)
		await assert.rejects(reads.read('a'), SingleflightClosedError)
		gate.resolve(undefined)
		assert.deepEqual(await second, { kind: 'value', value: undefined })
		await closing
		assert.equal(vi.getTimerCount(), 0)
	} finally {
		gate.resolve(undefined)
		await reads.close()
		vi.useRealTimers()
	}
})

test('overlapping distinct keys retain their own results and respect one global window', async () => {
	vi.useFakeTimers()
	const gate = deferred()
	const bothStarted = deferred()
	let calls = 0
	const reads = createRateLimitedReads(
		async (id) => {
			if (++calls === 2) bothStarted.resolve()
			await gate.promise
			return { id }
		},
		{ limit: 2, windowMs: 60_000 },
	)
	try {
		const first = reads.read('a')
		const second = reads.read('b')
		await bothStarted.promise
		assert.deepEqual(await reads.read('c'), { kind: 'rate-limited' })
		gate.resolve()
		assert.deepEqual(await Promise.all([first, second]), [
			{ kind: 'value', value: { id: 'a' } },
			{ kind: 'value', value: { id: 'b' } },
		])
		assert.equal(calls, 2)
	} finally {
		gate.resolve()
		await reads.close()
		assert.equal(vi.getTimerCount(), 0)
		vi.useRealTimers()
	}
})

test('read failures remain original, consume a token, and do not trigger hidden retries', async () => {
	vi.useFakeTimers()
	const reason = new Error('read failed')
	let calls = 0
	const reads = createRateLimitedReads(
		async () => {
			calls++
			throw reason
		},
		{ limit: 1, windowMs: 100 },
	)
	try {
		await assert.rejects(reads.read('a'), (error) => error === reason)
		assert.deepEqual(await reads.read('a'), { kind: 'rate-limited' })
		assert.equal(calls, 1)
		await vi.advanceTimersByTimeAsync(101)
		await assert.rejects(reads.read('a'), (error) => error === reason)
		assert.equal(calls, 2, 'new calls can enter after the window expires normally')
	} finally {
		await reads.close()
		assert.equal(vi.getTimerCount(), 0)
		vi.useRealTimers()
	}
})

test('counterexample: one global debouncer inside keyed flights suppresses a different key', async () => {
	vi.useFakeTimers()
	const executed: string[] = []
	const debounce = new AsyncDebouncer(
		async (id: string) => {
			executed.push(id)
			return { id }
		},
		{ wait: 20, throwOnError: true, asyncRetryerOptions: { maxAttempts: 1 } },
	)
	const flights = singleflight<string, { id: string } | undefined>()
	try {
		const first = flights.run('a', () => debounce.maybeExecute('a'))
		const second = flights.run('b', () => debounce.maybeExecute('b'))
		assert.equal(await first, undefined, 'key b cancelled key a at the global debouncer')
		assert.deepEqual(executed, [])
		await vi.advanceTimersByTimeAsync(20)
		assert.deepEqual(await second, { id: 'b' })
		assert.deepEqual(executed, ['b'])
	} finally {
		debounce.cancel()
		await flights.close()
		assert.equal(vi.getTimerCount(), 0)
		vi.useRealTimers()
	}
})
