import { describe, expect, it, vi } from 'vitest'
import { DevConsoleExecutor } from '../src/console/executor'
import { snapshotJson, type DevConsoleRunInput } from '../src/console/protocol'

function input(runId: string, extra: Partial<DevConsoleRunInput> = {}): DevConsoleRunInput {
	return {
		runId,
		file: '/project/dev.ts',
		exportName: 'default',
		sourceHash: 'a'.repeat(64),
		...extra,
	}
}
function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void
	const promise = new Promise<T>((finish) => {
		resolve = finish
	})
	return { promise, resolve }
}

describe('dev console execution ownership', () => {
	it('retains one execution across resubmission and disconnect-like result retrieval', async () => {
		const execute = vi.fn(async () => ({ count: 1 }))
		const executor = new DevConsoleExecutor('instance', execute)
		executor.submit(input('first'))
		executor.submit(input('first'))
		const result = await executor.settled('first')
		expect(result).toMatchObject({ state: 'succeeded', value: { count: 1 } })
		expect(executor.submit(input('first'))).toEqual(result)
		expect(execute).toHaveBeenCalledTimes(1)
		expect(() => executor.submit(input('first', { input: { changed: true } }))).toThrow(
			'different request',
		)
		executor.close()
	})

	it('does not release the running slot until cancelled code actually settles', async () => {
		const gate = deferred()
		const entered = deferred()
		const started: string[] = []
		const executor = new DevConsoleExecutor('instance', async (request) => {
			started.push(request.runId)
			if (request.runId === 'first') {
				entered.resolve()
				await gate.promise
			}
			return request.runId
		})
		executor.submit(input('first'))
		await entered.promise
		executor.submit(input('second'))
		expect(executor.cancel('first')).toMatchObject({ state: 'cancelling' })
		await Promise.resolve()
		expect(started).toEqual(['first'])
		expect(executor.result('second')).toMatchObject({ state: 'queued' })
		gate.resolve()
		expect(await executor.settled('first')).toMatchObject({ state: 'cancelled' })
		expect(await executor.settled('second')).toMatchObject({ state: 'succeeded', value: 'second' })
		executor.close()
	})

	it('keeps timeout cancellation observable while cleanup is still running', async () => {
		vi.useFakeTimers()
		const gate = deferred()
		const entered = deferred()
		const executor = new DevConsoleExecutor('instance', async (_request, run) => {
			entered.resolve()
			await gate.promise
			run.phase('cleanup')
			expect(executor.result('first')).toMatchObject({
				state: 'cancelling',
				cancelReason: 'timeout',
			})
			return null
		})
		try {
			executor.submit(input('first', { timeoutMs: 10 }))
			await vi.advanceTimersByTimeAsync(0)
			await entered.promise
			await vi.advanceTimersByTimeAsync(10)
			expect(executor.result('first')).toMatchObject({
				state: 'cancelling',
				cancelReason: 'timeout',
			})
			gate.resolve()
			expect(await executor.settled('first')).toMatchObject({
				state: 'cancelled',
				error: { code: 'timeout' },
			})
		} finally {
			executor.close()
			vi.useRealTimers()
		}
	})

	it('cancels queued operations without invoking them and limits admission', async () => {
		const gate = deferred()
		const entered = deferred()
		const execute = vi.fn(async () => {
			entered.resolve()
			await gate.promise
			return null
		})
		const executor = new DevConsoleExecutor('instance', execute)
		executor.submit(input('running'))
		await entered.promise
		for (let index = 0; index < 16; index++) executor.submit(input(`queued-${index}`))
		expect(() => executor.submit(input('overflow'))).toThrow('16 pending')
		expect(executor.cancel('queued-0')).toMatchObject({ state: 'cancelled', phase: 'admission' })
		executor.close()
		gate.resolve()
		await executor.settled('running')
		expect(execute).toHaveBeenCalledTimes(1)
	})

	it('does not replay an operation after its result was evicted', async () => {
		const execute = vi.fn(async () => null)
		const executor = new DevConsoleExecutor('instance', execute)
		for (let index = 0; index < 101; index++) {
			executor.submit(input(`run-${index}`))
			await executor.settled(`run-${index}`)
		}
		expect(() => executor.result('run-0')).toThrow('No retained result')
		let expiration: unknown
		try {
			executor.submit(input('run-0'))
		} catch (error) {
			expiration = error
		}
		expect(expiration).toMatchObject({ code: 'result_expired' })
		expect(execute).toHaveBeenCalledTimes(101)
		executor.close()
	})

	it('reports encoding failure after effects without replaying the operation', async () => {
		let writes = 0
		const executor = new DevConsoleExecutor('instance', async () => {
			writes++
			return { value: 1n }
		})
		executor.submit(input('write'))
		expect(await executor.settled('write')).toMatchObject({
			state: 'failed',
			phase: 'encode',
			error: { code: 'result_not_serializable' },
		})
		executor.submit(input('write'))
		expect(writes).toBe(1)
		executor.close()
	})
})

describe('dev JSON snapshots', () => {
	it('copies plain data using native undefined conventions without invoking getters or toJSON', () => {
		const source = { nested: { count: 1 }, absent: undefined, values: [undefined] }
		const copy = snapshotJson(source)
		source.nested.count = 2
		expect(copy).toEqual({ nested: { count: 1 }, values: [null] })
		const getter = vi.fn(() => 1)
		expect(() =>
			snapshotJson(Object.defineProperty({}, 'value', { enumerable: true, get: getter })),
		).toThrow('accessors')
		expect(getter).not.toHaveBeenCalled()
		const toJSON = vi.fn(() => 1)
		expect(() => snapshotJson({ toJSON })).toThrow('Return JSON')
		expect(toJSON).not.toHaveBeenCalled()
	})

	it('rejects cycles, capabilities, nonfinite values, and oversized output', () => {
		const cycle: unknown[] = []
		cycle.push(cycle)
		expect(() => snapshotJson(cycle)).toThrow('Circular')
		expect(() => snapshotJson(new Date())).toThrow('plain JSON')
		expect(() => snapshotJson(NaN)).toThrow('Return JSON')
		expect(() => snapshotJson('x'.repeat(1024 * 1024))).toThrow('1 MiB')
		expect(snapshotJson({ first: { value: 1 }, second: { value: 1 } })).toEqual({
			first: { value: 1 },
			second: { value: 1 },
		})
	})
})
