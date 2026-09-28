import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { test } from 'vitest'
import { asAsync, mapAsync } from 'lfi'
import { pMapIterable } from 'p-map'
import { mapConcurrent, toArray } from '@pluxel/async/iter'
import { report } from './report.ts'

const input = Array.from({ length: 128 }, (_, index) => index)
const expected = input.map((value) => value + 1)
type Mapper = (value: number) => Promise<number>
type Runner = (mapper: Mapper) => Promise<number[]>

// All cases consume every item successfully, in input order, using the same collector.
// This does not compare cancellation, failure cleanup, slow consumers or upstream
// pending reads: local admission includes pending reads and undelivered results;
// p-map exposes separate concurrency/backpressure controls. Their contracts differ.
const local =
	(concurrency: number): Runner =>
	(mapper) =>
		toArray(mapConcurrent(input, mapper, { concurrency, order: 'input' }))
const pMap =
	(concurrency: number): Runner =>
	(mapper) =>
		toArray(pMapIterable(input, mapper, { concurrency, backpressure: concurrency }))

const immediate: Mapper = async (value) => value + 1
const yielding: Mapper = async (value) => {
	await setImmediate()
	return value + 1
}

async function verify(run: Runner, concurrency: number): Promise<void> {
	let active = 0
	let peak = 0
	const output = await run(async (value) => {
		active++
		peak = Math.max(peak, active)
		await setImmediate()
		active--
		return value + 1
	})
	assert.deepEqual(output, expected)
	assert.equal(active, 0)
	assert.equal(peak, concurrency)
}

for (const workload of ['immediate', 'setImmediate'] as const) {
	test(`128 ordered pull items, concurrency/backpressure 4, ${workload} mapper`, async ({
		bench,
	}) => {
		const pluxel = local(4)
		const upstream = pMap(4)
		await verify(pluxel, 4)
		await verify(upstream, 4)
		const mapper = workload === 'immediate' ? immediate : yielding
		assert.deepEqual(await pluxel(mapper), expected)
		assert.deepEqual(await upstream(mapper), expected)
		const storage = await bench.compare(
			bench('pluxel mapConcurrent', async () => {
				await pluxel(mapper)
			}),
			bench('p-map pMapIterable', async () => {
				await upstream(mapper)
			}),
			{
				time: 500,
				iterations: 100,
				warmupTime: 100,
				warmupIterations: 10,
			},
		)
		report(`128 ordered pull items / concurrency 4 / ${workload}`, [
			storage.get('pluxel mapConcurrent'),
			storage.get('p-map pMapIterable'),
		])
	})
}

// lfi's mapConcur is a push/concurrent iterable, not the same bounded pull contract.
// Compare its standard sequential AsyncIterable mapping instead, with concurrency 1
// for both schedulers. This measures the extra scheduler cost for sequential work;
// it makes no claim about lfi concurrent processing or a backpressure adapter.
test('128 sequential ordered pull items, immediate mapper, lfi mapAsync baseline', async ({
	bench,
}) => {
	const pluxel = local(1)
	const upstream = pMap(1)
	const lfi: Runner = (mapper) => toArray(mapAsync(mapper, asAsync(input)))
	for (const run of [pluxel, upstream, lfi]) {
		await verify(run, 1)
		assert.deepEqual(await run(immediate), expected)
	}
	const storage = await bench.compare(
		bench('pluxel mapConcurrent (1)', async () => {
			await pluxel(immediate)
		}),
		bench('p-map pMapIterable (1)', async () => {
			await upstream(immediate)
		}),
		bench('lfi mapAsync (sequential)', async () => {
			await lfi(immediate)
		}),
		{ time: 500, iterations: 100, warmupTime: 100, warmupIterations: 10 },
	)
	report('128 ordered pull items / sequential / immediate', [
		storage.get('pluxel mapConcurrent (1)'),
		storage.get('p-map pMapIterable (1)'),
		storage.get('lfi mapAsync (sequential)'),
	])
})
