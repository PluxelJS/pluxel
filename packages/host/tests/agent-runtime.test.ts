import { describe, expect, it, vi } from 'vitest'
import {
	ScriptExecutor,
	ScriptExecutionError,
	snapshotJson,
	type ScriptSubmission,
} from '../src/agent'

const subject = 'admin:alice'
function input(runId: string, extra: Partial<ScriptSubmission> = {}): ScriptSubmission {
	return {
		runId,
		code: {
			kind: 'project',
			file: '/project/script.ts',
			exportName: 'default',
			sourceHash: 'a'.repeat(64),
		},
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

describe('script execution owner', () => {
	it('rejects oversized or nonportable input before execution with input diagnostics', async () => {
		const execute = vi.fn(async () => null)
		await using executor = new ScriptExecutor({ instanceId: 'owner', execute })
		await expect(
			executor.submit(input('large', { input: 'x'.repeat(1024 * 1024) }), subject),
		).rejects.toMatchObject({ code: 'input_too_large' })
		await expect(
			executor.submit(input('behavior', { input: new Date() as never }), subject),
		).rejects.toMatchObject({ code: 'invalid_input' })
		expect(execute).not.toHaveBeenCalled()
	})
	it('rechecks authorization after asynchronous hashing and before committing admission', async () => {
		const hashing = deferred(),
			release = deferred<ArrayBuffer>()
		const digest = vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(() => {
			hashing.resolve()
			return release.promise
		})
		const execute = vi.fn(async () => null)
		await using executor = new ScriptExecutor({ instanceId: 'owner', execute })
		let authorized = true
		try {
			const request = executor.submit(input('withdrawn'), subject, () => {
				if (!authorized)
					throw new ScriptExecutionError('unauthorized', 'Authorization was withdrawn')
			})
			await hashing.promise
			authorized = false
			executor.abortSubject(subject)
			release.resolve(new ArrayBuffer(32))
			await expect(request).rejects.toMatchObject({ code: 'unauthorized' })
			expect(execute).not.toHaveBeenCalled()
			expect(() => executor.result('withdrawn', subject)).toThrow(
				expect.objectContaining({ code: 'run_not_found' }),
			)
		} finally {
			release.resolve(new ArrayBuffer(32))
			digest.mockRestore()
		}
	})
	it('controls HMR independently while a script waits and replacement cancels only scripts', async () => {
		const entered = deferred(),
			release = deferred()
		const control = vi.fn(async () => {
			executor.abortScripts('host_changed')
			return { mode: 'paused' }
		})
		const executor = new ScriptExecutor({
			instanceId: 'owner',
			execute: async () => {
				entered.resolve()
				await release.promise
			},
			control,
		})
		try {
			await executor.submit(input('blocked'), subject)
			await entered.promise
			await executor.submit(input('queued'), subject)
			await executor.submitControl({ runId: 'apply', action: 'apply' }, subject)
			expect(await executor.settled('apply', subject)).toMatchObject({
				kind: 'hmr',
				action: 'apply',
				state: 'succeeded',
				value: { mode: 'paused' },
			})
			expect(executor.result('blocked', subject)).toMatchObject({
				state: 'cancelling',
				cancelReason: 'host_changed',
			})
			expect(executor.result('queued', subject)).toMatchObject({ state: 'cancelled' })
			await executor.submitControl({ runId: 'apply', action: 'apply' }, subject)
			expect(control).toHaveBeenCalledTimes(1)
			await expect(
				executor.submitControl({ runId: 'apply', action: 'resume' }, subject),
			).rejects.toMatchObject({ code: 'request_conflict' })
			await expect(executor.submit(input('apply'), subject)).rejects.toMatchObject({
				code: 'request_conflict',
			})
		} finally {
			release.resolve()
			await executor.close()
		}
	})
	it('keeps accepted code until real settlement and cancels queued calls without executing them', async () => {
		const entered = deferred(),
			release = deferred()
		const starts: string[] = []
		const executor = new ScriptExecutor({
			instanceId: 'owner',
			execute: async (request) => {
				starts.push(request.runId)
				if (request.runId === 'first') {
					entered.resolve()
					await release.promise
				}
				return request.runId
			},
		})
		try {
			await executor.submit(input('first'), subject)
			await entered.promise
			for (let index = 0; index < 16; index++)
				await executor.submit(input(`queued-${index}`), subject)
			await expect(executor.submit(input('overflow'), subject)).rejects.toMatchObject({
				code: 'queue_full',
			})
			expect(executor.cancel('queued-0', subject)).toMatchObject({
				state: 'cancelled',
				phase: 'admission',
			})
			expect(executor.cancel('first', subject)).toMatchObject({ state: 'cancelling' })
			expect(executor.result('queued-1', subject)).toMatchObject({ state: 'queued' })
			expect(starts).toEqual(['first'])
			release.resolve()
			expect(await executor.settled('first', subject)).toMatchObject({ state: 'cancelled' })
			expect(await executor.settled('queued-1', subject)).toMatchObject({
				state: 'succeeded',
				value: 'queued-1',
			})
		} finally {
			release.resolve()
			await executor.close()
		}
	})
	it('deduplicates concurrent delivery, retains original subject and permits disconnected querying', async () => {
		const execute = vi.fn(async () => ({ count: 1 }))
		await using executor = new ScriptExecutor({ instanceId: 'owner', execute })
		await Promise.all([
			executor.submit(input('same'), subject),
			executor.submit(input('same'), subject),
		])
		const result = await executor.settled('same', subject)
		expect(result).toMatchObject({
			state: 'succeeded',
			value: { count: 1 },
			requestHash: expect.stringMatching(/^[0-9a-f]{64}$/),
		})
		expect(await executor.submit(input('same'), subject)).toEqual(result)
		expect(execute).toHaveBeenCalledTimes(1)
		await expect(
			executor.submit(input('same', { input: { changed: true } }), subject),
		).rejects.toMatchObject({ code: 'request_conflict' })
		expect(() => executor.result('same', 'admin:bob')).toThrow(
			expect.objectContaining({ code: 'run_not_found' }),
		)
		expect(() => executor.cancel('same', 'admin:bob')).toThrow(
			expect.objectContaining({ code: 'run_not_found' }),
		)
		await expect(executor.submit(input('same'), 'admin:bob')).rejects.toMatchObject({
			code: 'run_not_found',
		})
	})
	it.each(['none', 'finally', 'using'] as const)(
		'retains timeout and actual %s failure until code settles',
		async (failure) => {
			const entered = deferred(),
				aborted = deferred(),
				release = deferred()
			const executor = new ScriptExecutor({
				instanceId: 'owner',
				execute: async (_request, run) => {
					run.signal.addEventListener('abort', () => aborted.resolve(), { once: true })
					entered.resolve()
					await release.promise
					run.phase('cleanup')
					if (failure === 'finally') throw new Error('resource cleanup failed')
					if (failure === 'using') {
						using resource = {
							[Symbol.dispose]() {
								throw new Error('resource cleanup failed')
							},
						}
						void resource
						run.signal.throwIfAborted()
					}
					return null
				},
			})
			try {
				await executor.submit(input('timeout', { timeoutMs: 50 }), subject)
				await entered.promise
				await aborted.promise
				expect(executor.result('timeout', subject)).toMatchObject({
					state: 'cancelling',
					cancelReason: 'timeout',
				})
				release.resolve()
				const result = await executor.settled('timeout', subject)
				expect(result).toMatchObject({ state: 'cancelled', error: { code: 'timeout' } })
				const expectedFailure = {
					executionError: { message: expect.stringContaining('resource cleanup failed') },
				}
				expect(result).toMatchObject(failure === 'none' ? {} : expectedFailure)
				expect('executionError' in result).toBe(failure !== 'none')
			} finally {
				release.resolve()
				await executor.close()
			}
		},
	)
	it('closes admission and drains actual active work before owner close completes', async () => {
		const entered = deferred(),
			release = deferred()
		const executor = new ScriptExecutor({
			instanceId: 'owner',
			execute: async () => {
				entered.resolve()
				await release.promise
			},
		})
		await executor.submit(input('active'), subject)
		await entered.promise
		await executor.submit(input('queued'), subject)
		let closed = false
		const close = (async () => {
			await executor.close()
			closed = true
		})()
		expect(executor.result('queued', subject)).toMatchObject({ state: 'cancelled' })
		await expect(executor.submit(input('later'), subject)).rejects.toMatchObject({
			code: 'owner_closed',
		})
		expect(closed).toBe(false)
		release.resolve()
		await close
		expect(closed).toBe(true)
	})
	it('retains tombstones after result eviction and never replays an effect after encode failure', async () => {
		let writes = 0
		await using executor = new ScriptExecutor({
			instanceId: 'owner',
			execute: async (request) => {
				writes++
				return request.runId === 'write' ? 1n : null
			},
		})
		await executor.submit(input('write'), subject)
		expect(await executor.settled('write', subject)).toMatchObject({
			state: 'failed',
			phase: 'encode',
			error: { code: 'result_not_serializable' },
		})
		await executor.submit(input('write'), subject)
		expect(writes).toBe(1)
		for (let index = 0; index < 100; index++) {
			await executor.submit(input(`run-${index}`), subject)
			await executor.settled(`run-${index}`, subject)
		}
		await expect(executor.submit(input('write'), subject)).rejects.toMatchObject({
			code: 'result_expired',
		})
		expect(writes).toBe(101)
	})
})

describe('portable result encoding', () => {
	it('copies native JSON data without evaluating accessors or toJSON', () => {
		const source: { nested: { count: number }; absent: undefined; values: undefined[] } = {
			nested: { count: 1 },
			absent: undefined,
			values: [undefined],
		}
		const copy = snapshotJson(source)
		source.nested.count = 2
		expect(copy).toEqual({ nested: { count: 1 }, values: [null] })
		const getter = vi.fn(() => 1),
			toJSON = vi.fn(() => 1)
		expect(() =>
			snapshotJson(Object.defineProperty({}, 'value', { enumerable: true, get: getter })),
		).toThrow('accessors')
		expect(() => snapshotJson({ toJSON })).toThrow('Return JSON')
		expect(getter).not.toHaveBeenCalled()
		expect(toJSON).not.toHaveBeenCalled()
		const dangerousKey = snapshotJson(JSON.parse('{"__proto__":{"value":1}}'))
		expect(Object.getPrototypeOf(dangerousKey)).toBe(Object.prototype)
		expect(Object.getOwnPropertyDescriptor(dangerousKey, '__proto__')?.value).toEqual({ value: 1 })
	})
	it('rejects cycles, capabilities, lossy numbers and oversized results', () => {
		const cycle: unknown[] = []
		cycle.push(cycle)
		expect(() => snapshotJson(cycle)).toThrow('Circular')
		expect(() => snapshotJson(new Date())).toThrow('plain JSON')
		expect(() => snapshotJson(NaN)).toThrow('Return JSON')
		expect(() => snapshotJson('x'.repeat(1024 * 1024))).toThrow('1 MiB')
	})
})
