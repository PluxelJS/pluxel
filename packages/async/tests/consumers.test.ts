import { test } from 'vitest'
import assert from 'node:assert/strict'
import { every, find, forEach, mapConcurrent, reduce, some } from '@pluxel/async/iter'
import { deferred, tick } from './helpers.ts'

test('consumers await promised inputs and callbacks in delivery order', async () => {
	const gate = deferred()
	const seen: number[] = []
	const completion = forEach([Promise.resolve(2), Promise.resolve(3)], async (value, index) => {
		seen.push(value + index)
		if (index === 0) await gate.promise
	})
	await tick()
	assert.deepEqual(seen, [2])
	gate.resolve()
	await completion
	assert.deepEqual(seen, [2, 4])
	assert.equal(
		await reduce([Promise.resolve(2), 3], async (total, value, index) => total + value + index, 0),
		6,
	)
	assert.equal(await reduce([], (total: number) => total + 1, 7), 7)
})

test('short-circuit consumers distinguish undefined matches and empty input', async () => {
	assert.equal(await some([undefined], (value) => value === undefined), true)
	assert.equal(await some([], () => true), false)
	assert.equal(await every([], () => false), true)
	assert.equal(await find([1, 2, 3], async (value, index) => value + index === 3), 2)
	assert.equal(await find([1, 2], () => false), undefined)
	let calls = 0
	assert.equal(
		await every([1, 2, 3], (value) => {
			calls++
			return value < 2
		}),
		false,
	)
	assert.equal(calls, 2)
})

test('find uses delivery order and waits for cooperative close and child drain', async () => {
	const slow = deferred<number>()
	const started = deferred()
	let slowSignal: AbortSignal | undefined
	let closed = false
	const source = {
		*[Symbol.iterator]() {
			try {
				yield 0
				yield 1
			} finally {
				closed = true
			}
		},
	}
	const values = mapConcurrent(
		source,
		(value, { signal }) => {
			if (value === 0) {
				slowSignal = signal
				started.resolve()
				return slow.promise
			}
			return value
		},
		{ concurrency: 2, order: 'completion' },
	)
	let finished = false
	const result = find(values, () => true).then((value) => {
		finished = true
		return value
	})
	await started.promise
	await tick()
	assert.equal(slowSignal?.aborted, true)
	assert.equal(finished, false)
	slow.resolve(0)
	assert.equal(await result, 1)
	assert.equal(closed, true)
})

test('consumer failure preserves primary error while closing upstream', async () => {
	const primary = new Error('predicate failed')
	let closed = false
	function* source() {
		try {
			yield 1
			yield 2
		} finally {
			closed = true
			// oxlint-disable-next-line eslint/no-unsafe-finally -- Fixture intentionally throws during close to verify primary-error preservation.
			throw new Error('close failed')
		}
	}
	await assert.rejects(
		find(source(), () => {
			throw primary
		}),
		(error) => error === primary,
	)
	assert.equal(closed, true)
	await assert.rejects(
		some(source(), () => true),
		/close failed/,
	)
})

test('rejected sync-generator values close the producer, and invalid callbacks never open it', async () => {
	let closed = false
	function* source() {
		try {
			yield Promise.reject(new Error('value failed'))
		} finally {
			closed = true
		}
	}
	await assert.rejects(
		forEach(source(), () => {}),
		/value failed/,
	)
	assert.equal(closed, true)
	let opened = false
	const input = {
		*[Symbol.iterator]() {
			opened = true
			yield 1
		},
	}
	await assert.rejects(find(input, null as never), /predicate/)
	await assert.rejects(forEach(input, null as never), /visit/)
	await assert.rejects(reduce(input, null as never, 0), /reducer/)
	assert.equal(opened, false)
})

test('reduce resolves promised initial values before opening the source or calling the reducer', async () => {
	const total = await reduce([1, 2], (sum, value) => sum + value, Promise.resolve(3))
	assert.equal(total, 6)
	assert.equal(await reduce([], (sum: number) => sum + 1, Promise.resolve(3)), 3)
	let opened = false
	const input = {
		*[Symbol.iterator]() {
			opened = true
			yield 1
		},
	}
	await assert.rejects(
		reduce(input, (sum: number, value) => sum + value, Promise.reject(new Error('initial failed'))),
		/initial failed/,
	)
	assert.equal(opened, false)
})
