import { test } from 'vitest'
import assert from 'node:assert/strict'
import { grfn } from '@pluxel/async/grfn'
import { deferred, tick } from './helpers.ts'

test('selected DAG is lazy, shares dependencies per run, and isolates concurrent runs', async () => {
	const g = grfn<number>()
	let calls = 0
	const shared = g.task({ input: g.input }, ({ input }) => {
		calls++
		return input * 2
	})
	const left = g.task({ shared }, (dependencies) => dependencies.shared + 1)
	const right = g.task({ shared }, async (dependencies) => dependencies.shared + 2)
	const total = g.task({ left, right }, (dependencies) => dependencies.left + dependencies.right)
	g.task({}, () => assert.fail('Unreachable task ran'))
	const run = g.compile({ total, shared })
	assert.equal(calls, 0)
	const results = Promise.all([run(1), run(2)])
	assert.equal(calls, 0, 'Calling run must not invoke a task synchronously')
	assert.deepEqual(await results, [
		{ total: 7, shared: 2 },
		{ total: 11, shared: 4 },
	])
	assert.equal(calls, 2)
	assert.equal(await g.compile(total)(3), 15)
})

test('a ready branch continues without a whole-level barrier', async () => {
	const g = grfn()
	const slow = deferred<number>()
	const bothStarted = deferred()
	const childStarted = deferred()
	let starts = 0
	const start = () => {
		if (++starts === 2) bothStarted.resolve()
	}
	const a = g.task({}, () => {
		start()
		return slow.promise
	})
	const b = g.task({}, () => {
		start()
		return 2
	})
	const child = g.task({ b }, (dependencies) => {
		childStarted.resolve()
		return dependencies.b + 1
	})
	const result = g.compile({ a, child })()
	await bothStarted.promise
	await childStarted.promise
	slow.resolve(1)
	assert.deepEqual(await result, { a: 1, child: 3 })
})

test('early and drain differ only in when the original failure is returned', async () => {
	for (const failure of ['early', 'drain'] as const) {
		const g = grfn()
		const slow = deferred<number>()
		const error = new Error('task failed')
		const a = g.task({}, () => {
			throw error
		})
		const b = g.task({}, () => slow.promise)
		let returned = false
		const result = g
			.compile({ a, b }, { failure })()
			.then(
				() => assert.fail('Expected rejection'),
				(reason) => {
					returned = true
					assert.equal(reason, error)
				},
			)
		await tick()
		assert.equal(returned, failure === 'early')
		slow.resolve(2)
		await result
	}
})

test('references are local; definition maps are snapshots and output keys are safe', async () => {
	const g = grfn()
	const first = g.task({}, () => 1)
	const second = g.task({}, () => 2)
	const dependencies = { value: first }
	const copy = g.task(dependencies, ({ value }) => value)
	dependencies.value = second
	const selection = { ['__proto__']: copy, alias: copy }
	const run = g.compile(selection)
	selection.alias = second
	const result = await run()
	assert.equal(Object.getPrototypeOf(result), Object.prototype)
	assert.deepEqual(result, { ['__proto__']: 1, alias: 1 })
	assert.throws(() => g.task({ wrong: grfn().input }, () => 0), TypeError)
	assert.throws(() => g.compile(grfn().input), TypeError)
	assert.throws(() => g.task({ wrong: 1 as never }, () => 0), TypeError)
	// This intentionally exercises the Promise-assimilation guard.
	// oxlint-disable-next-line unicorn/no-thenable -- The public contract explicitly rejects this hazardous key.
	assert.throws(() => g.compile({ then: first } as never), /then/)
})

test('deep reachable chains compile and execute without recursive stack growth', async () => {
	const g = grfn()
	let value = g.task({}, () => 0)
	for (let i = 0; i < 12_000; i++)
		value = g.task({ value }, (dependencies) => dependencies.value + 1)
	assert.equal(await g.compile(value)(), 12_000)
})
