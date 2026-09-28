import type { BenchResult } from 'vitest'
import assert from 'node:assert/strict'

for (const entry of ['grfn', 'iter', 'limit', 'retry', 'singleflight', 'wait']) {
	assert.ok(
		import.meta.resolve(`@pluxel/async/${entry}`).endsWith(`/dist/${entry}.js`),
		'Peer benchmarks must consume built package exports',
	)
}

/** Emit compact measured data without storing full sample arrays or adding another runner. */
export function report(scenario: string, results: readonly BenchResult[]): void {
	console.log(
		'ASYNC_BENCH',
		JSON.stringify({
			scenario,
			results: results.map((result) => ({
				name: result.name,
				meanUs: result.latency.mean * 1000,
				p50Us: result.latency.p50 * 1000,
				rmePercent: result.latency.rme,
				samples: result.latency.samplesCount,
			})),
		}),
	)
}
