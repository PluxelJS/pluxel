import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	WorkerThreadPool,
	type WorkerThreadFactory,
} from '../../src/node-artifact/WorkerThreadPool.ts'

class FakeWorker extends EventEmitter {
	readonly requests: unknown[] = []
	terminateCalls = 0
	refCalls = 0
	unrefCalls = 0
	private resolveTermination?: (code: number) => void
	private rejectTermination?: (error: Error) => void

	postMessage(value: unknown): void {
		this.requests.push(value)
	}

	terminate(): Promise<number> {
		this.terminateCalls += 1
		return new Promise<number>((resolve, reject) => {
			this.resolveTermination = resolve
			this.rejectTermination = reject
		})
	}

	ref(): void {
		this.refCalls += 1
	}

	unref(): void {
		this.unrefCalls += 1
	}

	respond(value: unknown): void {
		this.emit('message', value)
	}

	finishTermination(code = 1): void {
		this.emit('exit', code)
		this.resolveTermination?.(code)
	}

	failTermination(error: Error): void {
		this.rejectTermination?.(error)
	}
}

function taskId(worker: FakeWorker): number {
	return (worker.requests.at(-1) as { taskId: number }).taskId
}

describe('WorkerThreadPool', () => {
	afterEach(() => vi.useRealTimers())

	it('keeps successful workers reusable and settles capacity before the caller continuation', async () => {
		const workers: FakeWorker[] = []
		const createWorker: WorkerThreadFactory = () => {
			const worker = new FakeWorker()
			workers.push(worker)
			return worker as never
		}
		const pool = new WorkerThreadPool({ maxThreads: 1, idleTimeoutMs: 60_000 }, createWorker)
		const signal = new AbortController().signal

		const first = pool.run('/worker.mjs', { label: 'first' }, undefined, signal)
		workers[0]!.respond({ taskId: taskId(workers[0]!), ok: true, value: 'first' })
		await expect(first.settled).resolves.toBeUndefined()
		await expect(first.result).resolves.toBe('first')
		expect(workers[0]!.unrefCalls).toBe(1)

		const second = pool.run('/worker.mjs', { label: 'second' }, undefined, signal)
		expect(workers).toHaveLength(1)
		expect(workers[0]!.refCalls).toBe(1)
		workers[0]!.respond({ taskId: taskId(workers[0]!), ok: true, value: 'second' })
		await expect(second.result).resolves.toBe('second')
		await second.settled
		expect(workers[0]!.unrefCalls).toBe(2)

		const destroying = pool.destroy()
		await Promise.resolve()
		expect(workers[0]!.terminateCalls).toBe(1)
		expect(workers[0]!.refCalls).toBe(2)
		workers[0]!.finishTermination()
		await destroying
	})

	it('rejects an aborted caller immediately but retains capacity until termination settles', async () => {
		const workers: FakeWorker[] = []
		const createWorker: WorkerThreadFactory = () => {
			const worker = new FakeWorker()
			workers.push(worker)
			return worker as never
		}
		const pool = new WorkerThreadPool({ maxThreads: 1, idleTimeoutMs: 60_000 }, createWorker)
		const controller = new AbortController()
		const execution = pool.run('/worker.mjs', null, undefined, controller.signal)
		const reason = new Error('cancel active worker')

		controller.abort(reason)
		await expect(execution.result).rejects.toBe(reason)
		let resourceSettled = false
		void execution.settled.then(() => void (resourceSettled = true))
		await Promise.resolve()
		expect(resourceSettled).toBe(false)
		expect(workers[0]!.terminateCalls).toBe(1)
		expect(() =>
			pool.run('/worker.mjs', null, undefined, new AbortController().signal),
		).toThrowError('capacity invariant')

		workers[0]!.finishTermination()
		await execution.settled
		expect(resourceSettled).toBe(true)

		const next = pool.run('/worker.mjs', null, undefined, new AbortController().signal)
		expect(workers).toHaveLength(2)
		workers[1]!.respond({ taskId: taskId(workers[1]!), ok: true, value: 'next' })
		await expect(next.result).resolves.toBe('next')
		await next.settled
		const destroying = pool.destroy()
		await Promise.resolve()
		workers[1]!.finishTermination()
		await destroying
	})

	it('treats message deserialization failures as fatal and waits for worker exit', async () => {
		const workers: FakeWorker[] = []
		const pool = new WorkerThreadPool({ maxThreads: 1, idleTimeoutMs: 60_000 }, () => {
			const worker = new FakeWorker()
			workers.push(worker)
			return worker as never
		})
		const execution = pool.run('/worker.mjs', null, undefined, new AbortController().signal)
		const failure = new Error('cannot deserialize worker response')

		workers[0]!.emit('messageerror', failure)
		await expect(execution.result).rejects.toBe(failure)
		let resourceSettled = false
		void execution.settled.then(() => void (resourceSettled = true))
		await Promise.resolve()
		expect(resourceSettled).toBe(false)
		expect(workers[0]!.terminateCalls).toBe(1)

		workers[0]!.finishTermination()
		await expect(execution.settled).resolves.toBeUndefined()
		const next = pool.run('/worker.mjs', null, undefined, new AbortController().signal)
		workers[1]!.respond({ taskId: taskId(workers[1]!), ok: true, value: 'recovered' })
		await expect(next.result).resolves.toBe('recovered')
		await next.settled
		const destroying = pool.destroy()
		await Promise.resolve()
		workers[1]!.finishTermination()
		await destroying
	})

	it('terminates a Worker whose response does not match its running task', async () => {
		const worker = new FakeWorker()
		const pool = new WorkerThreadPool(
			{ maxThreads: 1, idleTimeoutMs: 60_000 },
			() => worker as never,
		)
		const execution = pool.run('/worker.mjs', null, undefined, new AbortController().signal)

		worker.respond({ taskId: taskId(worker) + 1, ok: true, value: 'stale' })
		await expect(execution.result).rejects.toThrow('invalid response')
		let resourceSettled = false
		void execution.settled.then(() => void (resourceSettled = true))
		await Promise.resolve()
		expect(resourceSettled).toBe(false)
		expect(worker.terminateCalls).toBe(1)
		worker.finishTermination()
		await execution.settled
		await pool.destroy()
	})

	it('keeps a Worker reusable after a handler reports a task failure', async () => {
		const worker = new FakeWorker()
		const pool = new WorkerThreadPool(
			{ maxThreads: 1, idleTimeoutMs: 60_000 },
			() => worker as never,
		)
		const signal = new AbortController().signal
		const failure = new Error('handler failed')
		const failed = pool.run('/worker.mjs', null, undefined, signal)
		worker.respond({ taskId: taskId(worker), ok: false, error: failure })
		await expect(failed.result).rejects.toBe(failure)
		await failed.settled

		const recovered = pool.run('/worker.mjs', null, undefined, signal)
		worker.respond({ taskId: taskId(worker), ok: true, value: 'recovered' })
		await expect(recovered.result).resolves.toBe('recovered')
		await recovered.settled
		const destroying = pool.destroy()
		await Promise.resolve()
		worker.finishTermination()
		await destroying
	})

	it('reports termination failure through resource settlement and pool shutdown', async () => {
		const worker = new FakeWorker()
		const pool = new WorkerThreadPool(
			{ maxThreads: 1, idleTimeoutMs: 60_000 },
			() => worker as never,
		)
		const controller = new AbortController()
		const execution = pool.run('/worker.mjs', null, undefined, controller.signal)
		const abort = new Error('cancel')
		const terminationFailure = new Error('terminate failed')

		controller.abort(abort)
		await expect(execution.result).rejects.toBe(abort)
		await Promise.resolve()
		worker.failTermination(terminationFailure)
		await expect(execution.settled).rejects.toBe(terminationFailure)
		expect(() =>
			pool.run('/worker.mjs', null, undefined, new AbortController().signal),
		).toThrowError('unavailable')
		await expect(pool.destroy()).rejects.toBe(terminationFailure)
	})

	it('admits replacement work while a task-free idle Worker is retiring', async () => {
		vi.useFakeTimers()
		const workers: FakeWorker[] = []
		const pool = new WorkerThreadPool({ maxThreads: 1, idleTimeoutMs: 10 }, () => {
			const worker = new FakeWorker()
			workers.push(worker)
			return worker as never
		})
		const signal = new AbortController().signal
		const first = pool.run('/worker.mjs', null, undefined, signal)
		workers[0]!.respond({ taskId: taskId(workers[0]!), ok: true, value: 'first' })
		await first.result
		await first.settled

		vi.advanceTimersByTime(10)
		await Promise.resolve()
		expect(workers[0]!.terminateCalls).toBe(1)
		const replacement = pool.run('/worker.mjs', null, undefined, signal)
		expect(workers).toHaveLength(2)
		workers[1]!.respond({ taskId: taskId(workers[1]!), ok: true, value: 'replacement' })
		await expect(replacement.result).resolves.toBe('replacement')
		await replacement.settled

		workers[0]!.finishTermination()
		const destroying = pool.destroy()
		await Promise.resolve()
		workers[1]!.finishTermination()
		await destroying
	})

	it('waits for detached idle retirement during shutdown', async () => {
		vi.useFakeTimers()
		const worker = new FakeWorker()
		const pool = new WorkerThreadPool({ maxThreads: 1, idleTimeoutMs: 10 }, () => worker as never)
		const execution = pool.run('/worker.mjs', null, undefined, new AbortController().signal)
		worker.respond({ taskId: taskId(worker), ok: true, value: undefined })
		await execution.result
		await execution.settled
		vi.advanceTimersByTime(10)
		await Promise.resolve()

		let destroyed = false
		const destroying = pool.destroy().then(() => void (destroyed = true))
		await Promise.resolve()
		expect(destroyed).toBe(false)
		worker.finishTermination()
		await destroying
		expect(destroyed).toBe(true)
	})

	it('retains a detached idle termination failure for later shutdown', async () => {
		vi.useFakeTimers()
		const worker = new FakeWorker()
		const pool = new WorkerThreadPool({ maxThreads: 1, idleTimeoutMs: 10 }, () => worker as never)
		const execution = pool.run('/worker.mjs', null, undefined, new AbortController().signal)
		worker.respond({ taskId: taskId(worker), ok: true, value: undefined })
		await execution.result
		await execution.settled
		vi.advanceTimersByTime(10)
		await Promise.resolve()
		const failure = new Error('idle termination failed')
		worker.failTermination(failure)
		for (let index = 0; index < 4; index++) await Promise.resolve()

		expect(() =>
			pool.run('/worker.mjs', null, undefined, new AbortController().signal),
		).toThrowError('unavailable')
		await expect(pool.destroy()).rejects.toBe(failure)
	})
})
