import { test } from 'vitest'
import assert from 'node:assert/strict'
import { mapConcurrent, toArray } from '@pluxel/async/iter'
import { limit } from '@pluxel/async/limit'

const input = Array.from({ length: 128 }, (_, index) => index)
const expected = input.map((value) => value + 1)

async function limited(): Promise<number[]> {
	const jobs = limit({ concurrency: 4 })
	try {
		return await Promise.all(input.map((value) => jobs.run(() => value + 1)))
	} finally {
		await jobs.close()
	}
}

async function iterated(): Promise<number[]> {
	return toArray(mapConcurrent(input, (value) => value + 1, { concurrency: 4 }))
}

test('128 immediate tasks, concurrency 4, including admission and collection', async ({
	bench,
}) => {
	assert.deepEqual(await limited(), expected)
	assert.deepEqual(await iterated(), expected)
	let result: number[] = []
	await bench.compare(
		bench('limit + Promise.all (eager admission)', async () => {
			result = await limited()
		}),
		bench('iter + toArray (bounded admission)', async () => {
			result = await iterated()
		}),
		{ time: 250, iterations: 100 },
	)
	assert.deepEqual(result, expected)
})
