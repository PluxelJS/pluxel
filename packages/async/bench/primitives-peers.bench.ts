import { test } from 'vitest'
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import pLimit from 'p-limit'
import pMemoize from 'p-memoize'
import pRetry from 'p-retry'
import { limit } from '@pluxel/async/limit'
import { singleflight } from '@pluxel/async/singleflight'
import { retry } from '@pluxel/async/retry'
import { report } from './report.ts'

const input = Array.from({ length: 128 }, (_, index) => index)
const expected = input.map((value) => value + 1)
const options = { time: 500, iterations: 100, warmupTime: 100, warmupIterations: 10 }

for (const deferred of [false, true]) {
	test(`limit: 128 tasks, concurrency 4, ${deferred ? 'setImmediate' : 'one microtask'} work`, async ({
		bench,
	}) => {
		const work = async (value: number) => {
			if (deferred) await setImmediate()
			return value + 1
		}
		async function local() {
			const queue = limit({ concurrency: 4 })
			try {
				return await Promise.all(input.map((value) => queue.run(() => work(value))))
			} finally {
				await queue.close()
			}
		}
		async function upstream() {
			const queue = pLimit(4)
			return Promise.all(input.map((value) => queue(() => work(value))))
		}
		// Independently verify shared workload admission; instrumentation is outside timing.
		for (const factory of [
			() => {
				const q = limit({ concurrency: 4 })
				return (fn: () => Promise<number>) => q.run(fn)
			},
			() => pLimit(4),
		]) {
			const run = factory()
			let active = 0,
				peak = 0
			await Promise.all(
				input.map((value) =>
					run(async () => {
						peak = Math.max(peak, ++active)
						await setImmediate()
						active--
						return value
					}),
				),
			)
			assert.equal(peak, 4)
			assert.equal(active, 0)
		}
		assert.deepEqual(await local(), expected)
		assert.deepEqual(await upstream(), expected)
		const results = await bench.compare(bench('pluxel', local), bench('p-limit', upstream), options)
		report(`limit/${deferred ? 'setImmediate' : 'microtask'}/128/c4`, [
			results.get('pluxel'),
			results.get('p-limit'),
		])
	})
}

for (const distinct of [1, 16]) {
	test(`singleflight: 128 calls across ${distinct} keys; construction excluded`, async ({
		bench,
	}) => {
		const keys = input.map((value) => value % distinct)
		let executions = 0
		const work = async (key: number) => {
			executions++
			return key + 1
		}
		const local = singleflight<number, number>()
		const upstream = pMemoize(work, { cache: false })
		const localRun = () => Promise.all(keys.map((key) => local.run(key, () => work(key))))
		const upstreamRun = () => Promise.all(keys.map((key) => upstream(key)))
		try {
			for (const run of [localRun, upstreamRun]) {
				executions = 0
				assert.deepEqual(
					await run(),
					keys.map((key) => key + 1),
				)
				assert.equal(executions, distinct)
				await run()
				assert.equal(executions, distinct * 2) // No settled-result caching.
			}
			const results = await bench.compare(
				bench('pluxel', localRun),
				bench('p-memoize', upstreamRun),
				options,
			)
			report(`singleflight/128/keys${distinct}`, [results.get('pluxel'), results.get('p-memoize')])
		} finally {
			await local.close()
		}
	})
}

// Zero backoff is deliberately NOT compared: p-retry skips its timer at zero,
// whereas local retry yields the event loop even at zero. Use equal positive delays.
for (const fails of [false, true]) {
	test(`retry: ${fails ? 'one failure then success, 1ms backoff' : 'first-attempt success'}`, async ({
		bench,
	}) => {
		const transient = new Error('temporary')
		function operation() {
			let calls = 0
			return async () => {
				if (++calls === 1 && fails) throw transient
				return calls
			}
		}
		const local = () =>
			retry(operation(), {
				attempts: 2,
				shouldRetry: (error) => error === transient,
				delayMs: 1,
				maxDelayMs: 1,
				factor: 1,
			})
		const upstream = () =>
			pRetry(operation(), {
				retries: 1,
				shouldRetry: ({ error }) => error === transient,
				minTimeout: 1,
				maxTimeout: 1,
				factor: 1,
				randomize: false,
			})
		assert.equal(await local(), fails ? 2 : 1)
		assert.equal(await upstream(), fails ? 2 : 1)
		const results = await bench.compare(bench('pluxel', local), bench('p-retry', upstream), options)
		report(`retry/${fails ? 'failure+1ms+success' : 'success'}`, [
			results.get('pluxel'),
			results.get('p-retry'),
		])
	})
}
