import { test, vi } from 'vitest'
import assert from 'node:assert/strict'
import { singleflight, SingleflightClosedError } from '@pluxel/async/singleflight'
import { deferred, tick } from './helpers.ts'

test('shares only pending work, including synchronously returned results', async () => {
	let calls = 0
	const flights = singleflight((key: string) => `${key}:${++calls}`)
	const first = flights.run('a')
	const second = flights.run('a')
	assert.equal(calls, 0)
	assert.deepEqual(await Promise.all([first, second, flights.run('b')]), ['a:1', 'a:1', 'b:2'])
	assert.equal(await flights.run('a'), 'a:3')
	await flights.close()
})

test('uses Map key equality without serializing objects or special strings', async () => {
	let calls = 0
	const flights = singleflight((key: unknown) => {
		calls++
		return key
	})
	const object = {}
	const other = {}
	const keys = [object, object, other, NaN, NaN, '__proto__', 'constructor', undefined]
	const values = await Promise.all(keys.map((key) => flights.run(key)))
	assert.deepEqual(values, keys)
	assert.equal(calls, 6)
	await flights.close()
})

test('releases rejected flights and preserves synchronous and asynchronous error identity', async () => {
	for (const asynchronous of [false, true]) {
		const error = new Error('operation failed')
		let calls = 0
		const flights = singleflight((_key: string) => {
			calls++
			if (asynchronous) return Promise.reject(error)
			throw error
		})
		await Promise.all([
			assert.rejects(flights.run('a'), (reason) => reason === error),
			assert.rejects(flights.run('a'), (reason) => reason === error),
		])
		assert.equal(calls, 1)
		await assert.rejects(flights.run('a'), (reason) => reason === error)
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
	const flights = singleflight((_key: string) => {
		calls++
		started.resolve()
		return gate.promise
	})
	await assert.rejects(
		flights.run('unused', { signal: AbortSignal.abort(reason) }),
		(error) => error === reason,
	)
	assert.equal(calls, 0)
	const leaving = flights.run('shared', { signal: controller.signal })
	const kept = flights.run('shared')
	const rejected = assert.rejects(leaving, (error) => error === reason)
	await started.promise
	controller.abort(reason)
	await rejected
	assert.equal(calls, 1)
	gate.resolve(42)
	assert.equal(await kept, 42)
	await flights.close()
})

test('close stops all admission immediately and drains abandoned failing work once', async () => {
	const gate = deferred<number>()
	const controller = new AbortController()
	const flights = singleflight((_key: string) => gate.promise)
	const leaving = flights.run('a', { signal: controller.signal })
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
	await assert.rejects(flights.run('a'), SingleflightClosedError)
	await assert.rejects(flights.run('b'), SingleflightClosedError)
	await tick()
	assert.equal(closed, false)
	gate.reject(new Error('late underlying failure'))
	await closing
	assert.equal(closed, true)
	assert.equal(flights.close(), closing)
})

test('reentrant run joins the admitted flight before the callback executes', async () => {
	let joined: Promise<number> | undefined
	let calls = 0
	const flights = singleflight((_key: string): number => {
		calls++
		joined = flights.run('a')
		return 7
	})
	assert.equal(await flights.run('a'), 7)
	assert.equal(await joined, 7)
	assert.equal(calls, 1)
	await flights.close()
})

test('validates operation and assimilates thenables', async () => {
	assert.throws(() => singleflight(null as never), TypeError)
	const flights = singleflight((key: number) => ({
		// oxlint-disable-next-line unicorn/no-thenable -- Verify standard thenable assimilation.
		then: (resolve: (value: number) => void) => resolve(key * 2),
	}))
	assert.equal(await flights.run(3), 6)
	await flights.close()
})

test('close drains accepted operations even before their callback starts', async () => {
	let calls = 0
	const flights = singleflight((_key: string) => ++calls)
	const accepted = flights.run('a')
	const closing = flights.close()
	assert.equal(calls, 0)
	await assert.rejects(flights.run('a'), SingleflightClosedError)
	assert.equal(await accepted, 1)
	await closing
	assert.equal(calls, 1)
})

test('cancelled waiters do not accumulate Promise subscriptions on shared pending work', async () => {
	const gate = deferred<number>()
	const flights = singleflight((_key: string) => gate.promise)
	const shared = flights.run('a')
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
		const waiting = flights.run('a', { signal: controller.signal })
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
		const flights = singleflight((_key: string) => gate.promise)
		const controllers = [new AbortController(), new AbortController()]
		const removals = controllers.map(({ signal }) => vi.spyOn(signal, 'removeEventListener'))
		const pending = controllers.map(({ signal }) => flights.run('a', { signal }))
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
