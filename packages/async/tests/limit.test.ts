import assert from 'node:assert/strict'
import { test } from 'vitest'
import { keyedLimit, limit, LimiterClosedError } from '@pluxel/async/limit'
import { deferred, tick } from './helpers.ts'

test('limit validates concurrency at creation', () => {
	for (const concurrency of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
		assert.throws(() => limit({ concurrency }), RangeError)
		assert.throws(() => keyedLimit({ concurrency }), RangeError)
	}
})

test('FIFO admission respects capacity and close drains queued work', async () => {
	const queue = limit({ concurrency: 2 })
	const gates = Array.from({ length: 4 }, () => deferred<number>())
	const started: number[] = []
	const results = gates.map((gate, index) =>
		queue.run(() => {
			started.push(index)
			return gate.promise
		}),
	)
	assert.deepEqual(started, [])
	assert.equal(queue.activeCount, 2)
	assert.equal(queue.pendingCount, 2)
	let closed = false
	const closing = queue.close()
	assert.equal(queue.close(), closing)
	void closing.then(() => {
		return (closed = true)
	})
	await assert.rejects(
		queue.run(() => 9),
		LimiterClosedError,
	)
	assert.deepEqual(started, [0, 1])
	gates[1]!.resolve(1)
	await results[1]
	await tick()
	assert.deepEqual(started, [0, 1, 2])
	assert.equal(queue.activeCount, 2)
	assert.equal(queue.pendingCount, 1)
	gates[2]!.resolve(2)
	await results[2]
	await tick()
	assert.deepEqual(started, [0, 1, 2, 3])
	gates[3]!.resolve(3)
	await results[3]
	assert.equal(closed, false)
	gates[0]!.resolve(0)
	assert.deepEqual(await Promise.all(results), [0, 1, 2, 3])
	await closing
	assert.equal(queue.activeCount, 0)
	assert.equal(queue.pendingCount, 0)
})

test('queued cancellation unlinks head, middle and tail without losing FIFO', async () => {
	const queue = limit({ concurrency: 1 })
	const gate = deferred<void>()
	const first = queue.run(() => gate.promise)
	const controllers = Array.from({ length: 5 }, () => new AbortController())
	const started: number[] = []
	const results = controllers.map((controller, index) =>
		queue.run(
			() => {
				started.push(index)
				return index
			},
			{ signal: controller.signal },
		),
	)
	const failures = [0, 2, 4].map((index) => {
		const reason = new Error(`cancel ${index}`)
		const rejected = assert.rejects(results[index]!, (error) => error === reason)
		controllers[index]!.abort(reason)
		return rejected
	})
	await Promise.all(failures)
	assert.equal(queue.pendingCount, 2)
	gate.resolve()
	await first
	assert.deepEqual(await Promise.all([results[1], results[3]]), [1, 3])
	assert.deepEqual(started, [1, 3])
	await queue.close()
})

test('running cancellation keeps its slot and preserves the task result', async () => {
	const queue = limit({ concurrency: 1 })
	const gate = deferred<number>()
	const controller = new AbortController()
	let nextStarted = false
	const first = queue.run(
		({ signal }) => {
			assert.equal(signal, controller.signal)
			return gate.promise
		},
		{ signal: controller.signal },
	)
	const next = queue.run(() => {
		nextStarted = true
	})
	await tick()
	controller.abort(new Error('cancelled'))
	await tick()
	assert.equal(queue.activeCount, 1)
	assert.equal(nextStarted, false)
	gate.resolve(7)
	assert.equal(await first, 7)
	await next
	await queue.close()
})

test('abort before startup prevents execution and running errors remain original', async () => {
	const queue = limit({ concurrency: 1 })
	const controller = new AbortController()
	const reason = new Error('abort')
	const failure = new Error('task')
	const beforeStart = queue.run(() => assert.fail('must not start'), { signal: controller.signal })
	controller.abort(reason)
	await assert.rejects(beforeStart, (error) => error === reason)
	await assert.rejects(
		queue.run(() => assert.fail('pre-aborted'), { signal: controller.signal }),
		(error) => error === reason,
	)
	const runningController = new AbortController()
	await assert.rejects(
		queue.run(
			() => {
				runningController.abort(reason)
				throw failure
			},
			{ signal: runningController.signal },
		),
		(error) => error === failure,
	)
	assert.equal(await queue.run(() => 5), 5)
	await queue.close()
})

test('keyed limits serialize each key independently and retain every call', async () => {
	const queue = keyedLimit<string>({ concurrency: 1 })
	const a = deferred<void>()
	const b = deferred<void>()
	const started: string[] = []
	const firstA = queue.run('a', async () => {
		started.push('a1')
		await a.promise
	})
	const secondA = queue.run('a', () => {
		started.push('a2')
	})
	const firstB = queue.run('b', async () => {
		started.push('b1')
		await b.promise
	})
	await tick()
	assert.deepEqual(started, ['a1', 'b1'])
	a.resolve()
	await Promise.all([firstA, secondA])
	assert.deepEqual(started, ['a1', 'b1', 'a2'])
	assert.equal(await queue.run('a', () => 42), 42)
	const closing = queue.close()
	assert.equal(queue.close(), closing)
	let closed = false
	void closing.then(() => {
		return (closed = true)
	})
	await assert.rejects(
		queue.run('c', () => 0),
		LimiterClosedError,
	)
	assert.equal(closed, false)
	b.resolve()
	await firstB
	await closing
})

test('keyed close drains queued failures without rejecting itself', async () => {
	const queue = keyedLimit<object>({ concurrency: 1 })
	const key = {}
	const gate = deferred<void>()
	const failure = new Error('task failed')
	const first = queue.run(key, () => gate.promise)
	const second = queue.run(key, () => {
		throw failure
	})
	const rejection = assert.rejects(second, (error) => error === failure)
	const closing = queue.close()
	gate.resolve()
	await Promise.all([first, rejection, closing])
	await assert.rejects(
		queue.run(key, () => 0),
		LimiterClosedError,
	)
})

test('invalid callbacks reject before entering a busy queue', async () => {
	const queue = limit({ concurrency: 1 })
	const keyed = keyedLimit<string>({ concurrency: 1 })
	const gate = deferred<void>()
	const first = queue.run(() => gate.promise)
	const keyedFirst = keyed.run('a', () => gate.promise)
	// @ts-expect-error verify JavaScript misuse without waiting for capacity
	await assert.rejects(queue.run(null), TypeError)
	// @ts-expect-error verify JavaScript misuse for keyed queues
	await assert.rejects(keyed.run('a', null), TypeError)
	assert.equal(queue.pendingCount, 0)
	gate.resolve()
	await Promise.all([first, keyedFirst, queue.close(), keyed.close()])
})

test('limiter factories snapshot concurrency before validation and admission', async () => {
	for (const keyed of [false, true]) {
		let reads = 0
		const options = {
			get concurrency() {
				return ++reads === 1 ? 1 : 0
			},
		}
		if (keyed) {
			const queue = keyedLimit<string>(options)
			assert.equal(reads, 1)
			assert.equal(await queue.run('a', () => 7), 7)
			await queue.close()
		} else {
			const queue = limit(options)
			assert.equal(reads, 1)
			assert.equal(await queue.run(() => 7), 7)
			await queue.close()
		}
	}
})

test('queued cancellation uses the snapshotted signal', async () => {
	const queue = limit({ concurrency: 1 })
	const gate = deferred<void>()
	const first = queue.run(() => gate.promise)
	const controller = new AbortController()
	let reads = 0
	const options = {
		get signal() {
			reads++
			return controller.signal
		},
	}
	const pending = queue.run(() => assert.fail('cancelled queue must not start'), options)
	assert.equal(reads, 1)
	const rejected = assert.rejects(pending)
	controller.abort()
	await rejected
	assert.equal(queue.pendingCount, 0)
	gate.resolve()
	await first
	await queue.close()
})
