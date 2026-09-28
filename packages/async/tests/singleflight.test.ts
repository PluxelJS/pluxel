import { test, vi } from 'vitest'
import assert from 'node:assert/strict'
import { singleflight, SingleflightClosedError } from '@pluxel/async/singleflight'
import { deferred, tick } from './helpers.ts'

test('first task wins only while pending, with no completed result cache', async () => {
	let calls = 0
	const flights = singleflight<string, string>()
	const first = flights.run('a', () => `a:${++calls}`)
	const second = flights.run('a', () => assert.fail('later same-key task must not run'))
	assert.equal(calls, 0)
	assert.equal(first, second)
	assert.deepEqual(await Promise.all([first, second, flights.run('b', () => `b:${++calls}`)]), [
		'a:1',
		'a:1',
		'b:2',
	])
	assert.equal(await flights.run('a', () => `new:${++calls}`), 'new:3')
	await flights.close()
})

test('uses Map key equality without serializing objects or special strings', async () => {
	let calls = 0
	const flights = singleflight<unknown, unknown>()
	const object = {}
	const other = {}
	const keys = [object, object, other, NaN, NaN, '__proto__', 'constructor', undefined]
	const values = await Promise.all(
		keys.map((key) =>
			flights.run(key, () => {
				calls++
				return key
			}),
		),
	)
	assert.deepEqual(values, keys)
	assert.equal(calls, 6)
	await flights.close()
})

test('get and size observe pending work without starting or caching it', async () => {
	const flights = singleflight<string, number>()
	const gate = deferred<number>()
	assert.equal(flights.size, 0)
	assert.equal(flights.get('missing'), undefined)
	const accepted = flights.run('a', () => gate.promise)
	assert.equal(flights.size, 1)
	assert.equal(flights.get('a'), accepted)
	const closing = flights.close()
	assert.equal(flights.get('a'), accepted)
	gate.resolve(3)
	assert.equal(await flights.get('a'), 3)
	await closing
	assert.equal(flights.get('a'), undefined)
	assert.equal(flights.size, 0)
})

test('drain snapshots current tasks, admits later work, and observes original failures', async () => {
	const flights = singleflight<string, number>()
	const firstGate = deferred<number>()
	const laterGate = deferred<number>()
	const reason = new Error('task failed')
	const first = flights.run('first', () => firstGate.promise)
	const failure = assert.rejects(first, (error) => error === reason)
	const drained = flights.drain()
	const later = flights.run('later', () => laterGate.promise)
	firstGate.reject(reason)
	await Promise.all([drained, failure])
	assert.equal(flights.size, 1)
	assert.equal(flights.get('later'), later)
	assert.equal(flights.get('first'), undefined)
	laterGate.resolve(7)
	assert.equal(await later, 7)
	await flights.drain()
	assert.equal(await flights.run('after-drain', () => 9), 9)
	await flights.close()
})

test('releases rejected flights and preserves synchronous and asynchronous error identity', async () => {
	for (const asynchronous of [false, true]) {
		const error = new Error('operation failed')
		let calls = 0
		const flights = singleflight<string, number>()
		const task = () => {
			calls++
			if (asynchronous) return Promise.reject(error)
			throw error
		}
		await Promise.all([
			assert.rejects(flights.run('a', task), (reason) => reason === error),
			assert.rejects(
				flights.run('a', () => assert.fail('must share failure')),
				(reason) => reason === error,
			),
		])
		assert.equal(calls, 1)
		await assert.rejects(flights.run('a', task), (reason) => reason === error)
		assert.equal(calls, 2)
		await flights.close()
	}
})

test('a pre-aborted waiter does not start work; one leaving does not cancel another', async () => {
	const gate = deferred<number>()
	const started = deferred()
	const controller = new AbortController()
	const reason = new Error('waiter left')
	let calls = 0
	const flights = singleflight<string, number>()
	const task = () => {
		calls++
		started.resolve()
		return gate.promise
	}
	await assert.rejects(
		flights.run('unused', task, { signal: AbortSignal.abort(reason) }),
		(error) => error === reason,
	)
	assert.equal(calls, 0)
	assert.equal(flights.size, 0)
	const leaving = flights.run('shared', task, { signal: controller.signal })
	const kept = flights.run('shared', () => assert.fail('must share'))
	const rejected = assert.rejects(leaving, (error) => error === reason)
	await started.promise
	controller.abort(reason)
	await rejected
	assert.equal(calls, 1)
	assert.equal(flights.get('shared'), kept)
	gate.resolve(42)
	assert.equal(await kept, 42)
	await flights.close()
})

test('close stops admission immediately and drains abandoned failing work once', async () => {
	const gate = deferred<number>()
	const controller = new AbortController()
	const flights = singleflight<string, number>()
	const leaving = flights.run('a', () => gate.promise, { signal: controller.signal })
	const rejected = assert.rejects(leaving)
	controller.abort()
	await rejected
	let closed = false
	const closing = flights.close()
	void closing.then(() => {
		closed = true
		return undefined
	})
	assert.equal(flights.close(), closing)
	await assert.rejects(
		flights.run('a', () => 1),
		SingleflightClosedError,
	)
	await assert.rejects(
		flights.run('b', () => 2),
		SingleflightClosedError,
	)
	await tick()
	assert.equal(closed, false)
	gate.reject(new Error('late underlying failure'))
	await closing
	assert.equal(closed, true)
	assert.equal(flights.close(), closing)
})

test('reentrant run joins admitted work before the callback executes', async () => {
	let joined: Promise<number> | undefined
	const flights = singleflight<string, number>()
	assert.equal(
		await flights.run('a', () => {
			joined = flights.run('a', () => assert.fail('recursive duplicate must not run'))
			return 7
		}),
		7,
	)
	assert.equal(await joined, 7)
	await flights.close()
})

test('validates every task before joining existing work and assimilates thenables', async () => {
	const flights = singleflight<string, number>()
	await assert.rejects(flights.run('empty', null as never), TypeError)
	assert.equal(flights.size, 0)
	const gate = deferred<number>()
	const accepted = flights.run('busy', () => gate.promise)
	await assert.rejects(flights.run('busy', null as never), TypeError)
	assert.equal(flights.get('busy'), accepted)
	gate.resolve(6)
	assert.equal(await accepted, 6)
	const thenable: PromiseLike<number> = {
		// oxlint-disable-next-line unicorn/no-thenable -- Verify standard thenable assimilation.
		then: (resolve, reject) => Promise.resolve(8).then(resolve, reject),
	}
	assert.equal(await flights.run('thenable', () => thenable), 8)
	await flights.close()
})

test('close drains accepted operations even before their callback starts', async () => {
	let calls = 0
	const flights = singleflight<string, number>()
	const accepted = flights.run('a', () => ++calls)
	const closing = flights.close()
	assert.equal(calls, 0)
	await assert.rejects(
		flights.run('a', () => ++calls),
		SingleflightClosedError,
	)
	assert.equal(await accepted, 1)
	await closing
	assert.equal(calls, 1)
})

test('cancelled waiters do not accumulate Promise subscriptions on shared pending work', async () => {
	const gate = deferred<number>()
	const flights = singleflight<string, number>()
	const shared = flights.run('a', () => gate.promise)
	const originalThen = shared.then
	let subscriptions = 0
	// Instrument this one returned Promise to detect reactions that cannot be removed
	// when a waiter leaves. No global Promise hooks or GC timing are involved.
	// oxlint-disable-next-line unicorn/no-thenable -- Instrument an existing Promise subscription method.
	Object.defineProperty(shared, 'then', {
		value(...args: Parameters<typeof originalThen>) {
			subscriptions++
			return originalThen.apply(shared, args)
		},
	})
	for (let index = 0; index < 100; index++) {
		const controller = new AbortController()
		const waiting = flights.run('a', () => assert.fail('must share'), { signal: controller.signal })
		const rejected = assert.rejects(waiting)
		controller.abort()
		await rejected
	}
	assert.equal(
		subscriptions,
		0,
		'each departing waiter must be removable without a source reaction',
	)
	gate.resolve(7)
	assert.equal(await shared, 7)
	await flights.close()
})

test('settlement notifies signalled waiters and removes every abort listener', async () => {
	for (const fails of [false, true]) {
		const gate = deferred<number>()
		const flights = singleflight<string, number>()
		const controllers = [new AbortController(), new AbortController()]
		const removals = controllers.map(({ signal }) => vi.spyOn(signal, 'removeEventListener'))
		const pending = controllers.map(({ signal }) =>
			flights.run('a', () => gate.promise, { signal }),
		)
		const error = new Error('original failure')
		const settled = fails
			? Promise.all(pending.map((promise) => assert.rejects(promise, (reason) => reason === error)))
			: Promise.all(pending)
		if (fails) gate.reject(error)
		else gate.resolve(42)
		const result = await settled
		if (!fails) assert.deepEqual(result, [42, 42])
		for (const remove of removals) {
			assert.equal(remove.mock.calls.length, 1)
			assert.equal(remove.mock.calls[0]![0], 'abort')
			remove.mockRestore()
		}
		await flights.close()
	}
})
