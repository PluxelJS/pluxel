import assert from 'node:assert/strict'
import { test } from 'vitest'
import upstreamGrfn from 'grfn'
import { grfn, type Ref } from '@pluxel/async/grfn'
import { report } from './report.ts'

// Both libraries execute the same async arithmetic. These measure orchestration,
// not IO throughput; both libraries are loaded as built ESM without the Vite module runner.
type Root = (input: number) => Promise<number>
type GraphFactory = (root?: Root) => (input: number) => Promise<number>

const increment: Root = async (input) => input + 1
const double = async (input: number) => input * 2
const triple = async (input: number) => input * 3
const leaf = async (input: number, offset: number) => input + offset
const sum = async (values: number[]) => values.reduce((total, value) => total + value, 0)

function localDiamond(rootWork: Root = increment) {
	const graph = grfn<number>()
	const root = graph.task({ input: graph.input }, ({ input }) => rootWork(input))
	const left = graph.task({ root }, (values) => double(values.root))
	const right = graph.task({ root }, (values) => triple(values.root))
	return graph.compile(graph.task({ left, right }, (values) => sum([values.left, values.right])))
}

function upstreamDiamond(rootWork: Root = increment) {
	return upstreamGrfn({
		root: rootWork,
		left: [double, ['root']],
		right: [triple, ['root']],
		output: [(left: number, right: number) => sum([left, right]), ['left', 'right']],
	})
}

function localFanout(rootWork: Root = increment) {
	const graph = grfn<number>()
	const root = graph.task({ input: graph.input }, ({ input }) => rootWork(input))
	const leaves: Record<string, Ref<number>> = {}
	for (let index = 0; index < 32; index++) {
		leaves[`leaf${index}`] = graph.task({ root }, (values) => leaf(values.root, index))
	}
	return graph.compile(graph.task(leaves, (values) => sum(Object.values(values))))
}

function upstreamFanout(rootWork: Root = increment) {
	// Explicit keys preserve upstream's normal compile-time graph validation.
	return upstreamGrfn({
		root: rootWork,
		leaf0: [(root: number) => leaf(root, 0), ['root']],
		leaf1: [(root: number) => leaf(root, 1), ['root']],
		leaf2: [(root: number) => leaf(root, 2), ['root']],
		leaf3: [(root: number) => leaf(root, 3), ['root']],
		leaf4: [(root: number) => leaf(root, 4), ['root']],
		leaf5: [(root: number) => leaf(root, 5), ['root']],
		leaf6: [(root: number) => leaf(root, 6), ['root']],
		leaf7: [(root: number) => leaf(root, 7), ['root']],
		leaf8: [(root: number) => leaf(root, 8), ['root']],
		leaf9: [(root: number) => leaf(root, 9), ['root']],
		leaf10: [(root: number) => leaf(root, 10), ['root']],
		leaf11: [(root: number) => leaf(root, 11), ['root']],
		leaf12: [(root: number) => leaf(root, 12), ['root']],
		leaf13: [(root: number) => leaf(root, 13), ['root']],
		leaf14: [(root: number) => leaf(root, 14), ['root']],
		leaf15: [(root: number) => leaf(root, 15), ['root']],
		leaf16: [(root: number) => leaf(root, 16), ['root']],
		leaf17: [(root: number) => leaf(root, 17), ['root']],
		leaf18: [(root: number) => leaf(root, 18), ['root']],
		leaf19: [(root: number) => leaf(root, 19), ['root']],
		leaf20: [(root: number) => leaf(root, 20), ['root']],
		leaf21: [(root: number) => leaf(root, 21), ['root']],
		leaf22: [(root: number) => leaf(root, 22), ['root']],
		leaf23: [(root: number) => leaf(root, 23), ['root']],
		leaf24: [(root: number) => leaf(root, 24), ['root']],
		leaf25: [(root: number) => leaf(root, 25), ['root']],
		leaf26: [(root: number) => leaf(root, 26), ['root']],
		leaf27: [(root: number) => leaf(root, 27), ['root']],
		leaf28: [(root: number) => leaf(root, 28), ['root']],
		leaf29: [(root: number) => leaf(root, 29), ['root']],
		leaf30: [(root: number) => leaf(root, 30), ['root']],
		leaf31: [(root: number) => leaf(root, 31), ['root']],
		output: [
			(...values: number[]) => sum(values),
			[
				'leaf0',
				'leaf1',
				'leaf2',
				'leaf3',
				'leaf4',
				'leaf5',
				'leaf6',
				'leaf7',
				'leaf8',
				'leaf9',
				'leaf10',
				'leaf11',
				'leaf12',
				'leaf13',
				'leaf14',
				'leaf15',
				'leaf16',
				'leaf17',
				'leaf18',
				'leaf19',
				'leaf20',
				'leaf21',
				'leaf22',
				'leaf23',
				'leaf24',
				'leaf25',
				'leaf26',
				'leaf27',
				'leaf28',
				'leaf29',
				'leaf30',
				'leaf31',
			],
		],
	})
}

async function verify(factory: GraphFactory, expected: (input: number) => number): Promise<void> {
	let rootCalls = 0
	const run = factory((input) => {
		rootCalls++
		return increment(input)
	})
	for (const input of [2, 3]) {
		assert.equal(await run(input), expected(input))
	}
	assert.equal(rootCalls, 2, 'A shared root executes exactly once per invocation')
}

const options = { time: 500, iterations: 100, warmupTime: 100, warmupIterations: 10 }

test('grfn peers: diamond, build once and execute repeatedly', async ({ bench }) => {
	await verify(localDiamond, (input) => (input + 1) * 5)
	await verify(upstreamDiamond, (input) => (input + 1) * 5)
	const local = localDiamond()
	const upstream = upstreamDiamond()
	let localResult = 0
	let upstreamResult = 0
	const results = await bench.compare(
		bench('local grfn', async () => {
			localResult = await local(2)
		}),
		bench('grfn 3.0.0', async () => {
			upstreamResult = await upstream(2)
		}),
		options,
	)
	assert.equal(localResult, 15)
	assert.equal(upstreamResult, 15)
	report('grfn diamond: reused graph', [results.get('local grfn'), results.get('grfn 3.0.0')])
})

test('grfn peers: diamond, include declaration and compilation each invocation', async ({
	bench,
}) => {
	await verify(localDiamond, (input) => (input + 1) * 5)
	await verify(upstreamDiamond, (input) => (input + 1) * 5)
	let localResult = 0
	let upstreamResult = 0
	const results = await bench.compare(
		bench('local grfn', async () => {
			localResult = await localDiamond()(2)
		}),
		bench('grfn 3.0.0', async () => {
			upstreamResult = await upstreamDiamond()(2)
		}),
		options,
	)
	assert.equal(localResult, 15)
	assert.equal(upstreamResult, 15)
	report('grfn diamond: build and execute', [results.get('local grfn'), results.get('grfn 3.0.0')])
})

test('grfn peers: shared root, 32 parallel leaves and sum, build once', async ({ bench }) => {
	await verify(localFanout, (input) => (input + 1) * 32 + 496)
	await verify(upstreamFanout, (input) => (input + 1) * 32 + 496)
	const local = localFanout()
	const upstream = upstreamFanout()
	let localResult = 0
	let upstreamResult = 0
	const results = await bench.compare(
		bench('local grfn', async () => {
			localResult = await local(2)
		}),
		bench('grfn 3.0.0', async () => {
			upstreamResult = await upstream(2)
		}),
		options,
	)
	assert.equal(localResult, 592)
	assert.equal(upstreamResult, 592)
	report('grfn 32-leaf fanout: reused graph', [
		results.get('local grfn'),
		results.get('grfn 3.0.0'),
	])
})
