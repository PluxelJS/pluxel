import { test } from 'vitest'
import assert from 'node:assert/strict'
import { mapConcurrent, SKIP, take, batch, toArray } from '@pluxel/async/iter'
import { deferred, tick } from './helpers.ts'

test('ordered output waits for the first input; completion order does not', async () => {
	for (const order of ['input', 'completion'] as const) {
		const slow = deferred<number>()
		let delivered = false
		const iterator = mapConcurrent([0, 1], (n) => (n === 0 ? slow.promise : 1), {
			concurrency: 2,
			order,
		})[Symbol.asyncIterator]()
		const first = iterator.next().then((item) => {
			delivered = true
			return item
		})
		await tick()
		assert.equal(delivered, order === 'completion')
		slow.resolve(0)
		const firstItem = await first
		const secondItem = await iterator.next()
		const end = await iterator.next()
		assert.equal(firstItem.value, order === 'input' ? 0 : 1)
		assert.equal(secondItem.value, order === 'input' ? 1 : 0)
		assert.equal(end.done, true)
	}
})

test('a paused consumer bounds the entire window, not just active mappers', async () => {
	let opened = 0,
		pulled = 0,
		closed = false
	let active = 0,
		peak = 0
	function* source() {
		opened++
		try {
			while (true) yield pulled++
		} finally {
			closed = true
		}
	}
	const values = mapConcurrent(
		source(),
		async (n) => {
			peak = Math.max(peak, ++active)
			await tick()
			active--
			return n
		},
		{ concurrency: 3 },
	)
	const iterator = values[Symbol.asyncIterator]()
	assert.equal(opened, 0)
	const first = await iterator.next()
	assert.equal(first.value, 0)
	await tick()
	await tick()
	assert.equal(pulled, 4, 'One delivered item plus three occupied slots')
	await tick()
	assert.equal(pulled, 4, 'Completed mappers must not refill the paused queue')
	assert.equal(peak, 3)
	await iterator.return?.()
	assert.equal(active, 0)
	assert.equal(closed, true)
})

test('a pending source read does not block a ready value or overlap another read', async () => {
	const pending = deferred<IteratorResult<number>>()
	let reads = 0,
		busy = false
	const source: AsyncIterable<number> = {
		[Symbol.asyncIterator]() {
			return {
				async next() {
					assert.equal(busy, false)
					busy = true
					const item = reads++ === 0 ? { done: false, value: 7 } : await pending.promise
					busy = false
					return item
				},
			}
		},
	}
	const iterator = mapConcurrent(source, (n) => n, { concurrency: 2 })[Symbol.asyncIterator]()
	const first = await iterator.next()
	assert.equal(first.value, 7)
	assert.equal(reads, 2)
	pending.resolve({ done: true, value: undefined })
	const end = await iterator.next()
	assert.equal(end.done, true)
})

test('SKIP composes with take and batch without swallowing valid falsy results', async () => {
	const values = mapConcurrent([1, 2, 3, 4, 5], async (n) => (n === 2 ? SKIP : n), {
		concurrency: 2,
	})
	assert.deepEqual(await toArray(batch(take(values, 3), 2)), [[1, 3], [4]])
	const falsy = [undefined, null, false, 0] as const
	assert.deepEqual(await toArray(mapConcurrent(falsy, (value) => value, { concurrency: 2 })), falsy)
	assert.deepEqual(
		await toArray(mapConcurrent([Promise.resolve(3)], (n) => n + 1, { concurrency: 1 })),
		[4],
	)
})

test('failure aborts siblings, drains them and preserves even an undefined rejection', async () => {
	const first = deferred<number>()
	const sibling = deferred<number>()
	const started = deferred()
	const aborted = deferred()
	let starts = 0,
		closed = false,
		returned = false
	function* source() {
		try {
			yield 0
			yield 1
		} finally {
			closed = true
			// The test proves that cleanup cannot replace the mapper's primary failure.
			// oxlint-disable-next-line eslint/no-unsafe-finally -- Deliberately simulates a failing iterator cleanup.
			throw new Error('Cleanup must not replace the task failure')
		}
	}
	const output = mapConcurrent(
		source(),
		(n, { signal }) => {
			if (++starts === 2) started.resolve()
			if (n === 1) signal.addEventListener('abort', () => aborted.resolve(), { once: true })
			return n === 0 ? first.promise : sibling.promise
		},
		{ concurrency: 2 },
	)
	const result = toArray(output).then(
		() => assert.fail('Expected rejection'),
		(reason) => {
			returned = true
			assert.equal(reason, undefined)
		},
	)
	await started.promise
	first.reject(undefined)
	await aborted.promise
	await tick()
	assert.equal(returned, false)
	sibling.resolve(1)
	await result
	assert.equal(closed, true)
})

test('external abort drains a pending source read before calling return', async () => {
	const controller = new AbortController()
	const pending = deferred<IteratorResult<number>>()
	const reading = deferred()
	const reason = new Error('Cancelled by caller')
	let reads = 0,
		busy = false,
		closed = false,
		mapped = 0
	const source: AsyncIterable<number> = {
		[Symbol.asyncIterator]() {
			return {
				async next() {
					if (reads++ === 0) return { done: false, value: 0 }
					busy = true
					reading.resolve()
					const item = await pending.promise
					busy = false
					return item
				},
				async return() {
					assert.equal(busy, false)
					closed = true
					return { done: true, value: undefined }
				},
			}
		},
	}
	const iterator = mapConcurrent(
		source,
		(n) => {
			mapped++
			return n
		},
		{ concurrency: 2, signal: controller.signal },
	)[Symbol.asyncIterator]()
	await iterator.next()
	await reading.promise
	controller.abort(reason)
	const result = iterator.next().then(
		() => assert.fail('Expected cancellation'),
		(error) => assert.equal(error, reason),
	)
	await tick()
	assert.equal(closed, false)
	pending.resolve({ done: false, value: 1 })
	await result
	assert.equal(closed, true)
	assert.equal(mapped, 1, 'Do not start work for an item read after cancellation')
})

test('early take aborts outstanding work and closes its source before returning', async () => {
	const started = deferred()
	const pending = deferred<number>()
	let closed = false,
		aborted = false
	function* source() {
		try {
			yield 0
			yield 1
		} finally {
			closed = true
		}
	}
	const mapped = mapConcurrent(
		source(),
		async (n, { signal }) => {
			if (n === 0) {
				await started.promise
				return 0
			}
			signal.addEventListener(
				'abort',
				() => {
					aborted = true
					pending.resolve(1)
				},
				{ once: true },
			)
			started.resolve()
			return pending.promise
		},
		{ concurrency: 2 },
	)
	assert.deepEqual(await toArray(take(mapped, 1)), [0])
	assert.equal(aborted, true)
	assert.equal(closed, true)
})

test('collectors close a sync generator that yields a rejected promise', async () => {
	const error = new Error('Input failed')
	let closed = false
	function* source() {
		try {
			yield Promise.reject(error)
		} finally {
			closed = true
		}
	}
	await assert.rejects(toArray(batch(source(), 2)), (reason) => reason === error)
	assert.equal(closed, true)
})

test('numeric bounds fail at declaration; take zero never opens its source', async () => {
	for (const invalid of [0, -1, 1.5, Infinity]) {
		assert.throws(() => mapConcurrent([], (n) => n, { concurrency: invalid }), RangeError)
		assert.throws(() => batch([], invalid), RangeError)
	}
	assert.throws(() => take([], -1), RangeError)
	assert.throws(
		() => mapConcurrent([], (n) => n, { concurrency: 1, order: 'bad' as never }),
		TypeError,
	)
	const source: Iterable<number> = {
		[Symbol.iterator]() {
			assert.fail('Source opened')
		},
	}
	assert.deepEqual(await toArray(take(source, 0)), [])
})
