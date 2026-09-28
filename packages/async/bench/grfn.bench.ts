import { test } from 'vitest'
import assert from 'node:assert/strict'
import { grfn } from '@pluxel/async/grfn'

// Measures orchestration overhead, not IO throughput or upstream grfn.
const g = grfn<number>()
const root = g.task({ input: g.input }, ({ input }) => input + 1)
const left = g.task({ root }, (dependencies) => dependencies.root * 2)
const right = g.task({ root }, (dependencies) => dependencies.root * 3)
const run = g.compile(
	g.task({ left, right }, (dependencies) => dependencies.left + dependencies.right),
)

async function manual(input: number): Promise<number> {
	const rootValue = await Promise.resolve(input).then((n) => n + 1)
	const [leftValue, rightValue] = await Promise.all([
		Promise.resolve().then(() => rootValue * 2),
		Promise.resolve().then(() => rootValue * 3),
	])
	return leftValue + rightValue
}

test('compiled diamond vs explicit promises, excluding declaration/compile cost', async ({
	bench,
}) => {
	let result = 0
	assert.equal(await run(2), await manual(2))
	await bench.compare(
		bench('compiled graph', async () => {
			result = await run(2)
		}),
		bench('explicit promises', async () => {
			result = await manual(2)
		}),
		{ time: 250, iterations: 100 },
	)
	assert.equal(result, 15)
})
