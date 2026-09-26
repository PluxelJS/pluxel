import { Worker, type Transferable } from 'node:worker_threads'
import { pathToFileURL } from 'node:url'

type WorkerRequest = Readonly<{
	taskId: number
	filename: string
	input: unknown
}>

type WorkerResponse =
	| Readonly<{ taskId: number; ok: true; value: unknown }>
	| Readonly<{ taskId: number; ok: false; error: unknown }>

type WorkerHandle = {
	postMessage(value: unknown, transferList?: readonly Transferable[]): void
	terminate(): Promise<number>
	ref?(): void
	unref?(): void
	on(event: 'message', listener: (value: unknown) => void): unknown
	on(event: 'error', listener: (error: Error) => void): unknown
	on(event: 'messageerror', listener: (error: Error) => void): unknown
	on(event: 'exit', listener: (code: number) => void): unknown
}

export type WorkerThreadFactory = () => WorkerHandle

export type WorkerThreadExecution = Readonly<{
	/** Caller-facing task result. Abort rejects this before worker termination necessarily completes. */
	result: Promise<unknown>
	/** Resolves only after the worker resource can be reused or has fully exited. */
	settled: Promise<void>
}>

type RunningTask = {
	readonly id: number
	readonly signal: AbortSignal
	readonly onAbort: () => void
	readonly resolveResult: (value: unknown) => void
	readonly rejectResult: (reason: unknown) => void
	readonly resolveSettled: () => void
	readonly rejectSettled: (reason: unknown) => void
	resultSettled: boolean
	resourceSettled: boolean
}

type WorkerSlot = {
	readonly worker: WorkerHandle
	state: 'idle' | 'running' | 'terminating' | 'terminated'
	task?: RunningTask
	idleTimer?: ReturnType<typeof setTimeout>
	termination?: Promise<void>
	failure?: Error
}

export type WorkerThreadPoolOptions = Readonly<{
	/** Maximum slots that may execute tasks concurrently. */
	maxThreads: number
	idleTimeoutMs: number
}>

const WORKER_ENTRY_SOURCE = `
import { parentPort } from 'node:worker_threads'

if (!parentPort) throw new Error('Pluxel worker task entry requires a parent port')

parentPort.on('message', async (request) => {
	let response
	try {
		const module = await import(request.filename)
		const handler = module.default
		if (typeof handler !== 'function') {
			throw new TypeError('Worker task module must default-export a function')
		}
		response = { taskId: request.taskId, ok: true, value: await handler(request.input) }
	} catch (error) {
		response = { taskId: request.taskId, ok: false, error }
	}
	try {
		parentPort.postMessage(response)
	} catch (error) {
		parentPort.postMessage({ taskId: request.taskId, ok: false, error })
	}
})
`

const WORKER_ENTRY_URL = new URL(`data:text/javascript,${encodeURIComponent(WORKER_ENTRY_SOURCE)}`)

/**
 * Persistent worker-thread executor below WorkerTaskService's public fair admission queue.
 *
 * The pool deliberately exposes separate result and resource-settlement promises. Node cannot
 * preempt arbitrary native work immediately, so an aborted task may reject its caller while the
 * terminating Worker still consumes process resources. A running slot remains admitted until that
 * Worker exits. An idle retiring Worker has no task and leaves execution admission immediately, so
 * its teardown may briefly overlap a replacement Worker's startup without overlapping heavy work.
 */
export class WorkerThreadPool {
	private readonly slots = new Set<WorkerSlot>()
	private readonly terminations = new Set<Promise<void>>()
	private nextTaskId = 1
	private active = true
	private failure?: Error

	constructor(
		private readonly options: WorkerThreadPoolOptions,
		private readonly createWorker: WorkerThreadFactory = () =>
			new Worker(WORKER_ENTRY_URL) as WorkerHandle,
	) {}

	run(
		filename: string,
		input: unknown,
		transferList: readonly ArrayBuffer[] | undefined,
		signal: AbortSignal,
	): WorkerThreadExecution {
		if (!this.active) throw new Error('Worker thread pool is stopped')
		if (this.failure) throw new Error('Worker thread pool is unavailable', { cause: this.failure })
		if (signal.aborted) return rejectedExecution(abortReason(signal))

		const slot = this.acquireSlot()
		let resolveResult!: (value: unknown) => void
		let rejectResult!: (reason: unknown) => void
		let resolveSettled!: () => void
		let rejectSettled!: (reason: unknown) => void
		const result = new Promise<unknown>((resolve, reject) => {
			resolveResult = resolve
			rejectResult = reject
		})
		const settled = new Promise<void>((resolve, reject) => {
			resolveSettled = resolve
			rejectSettled = reject
		})
		let task!: RunningTask
		task = {
			id: this.nextTaskId++,
			signal,
			onAbort: () => this.abortTask(slot, task, abortReason(signal)),
			resolveResult,
			rejectResult,
			resolveSettled,
			rejectSettled,
			resultSettled: false,
			resourceSettled: false,
		}
		slot.state = 'running'
		slot.task = task
		signal.addEventListener('abort', task.onAbort, { once: true })

		try {
			const request: WorkerRequest = {
				taskId: task.id,
				filename: pathToFileURL(filename).href,
				input,
			}
			slot.worker.postMessage(request, transferList)
		} catch (cause) {
			this.finishReusableTask(slot, task, { ok: false, error: cause })
		}

		return Object.freeze({ result, settled })
	}

	async destroy(): Promise<void> {
		if (!this.active) {
			const results = await Promise.allSettled(this.terminations)
			const failed = results.find(
				(result): result is PromiseRejectedResult => result.status === 'rejected',
			)
			if (failed) throw failed.reason
			if (this.failure) throw this.failure
			return
		}
		this.active = false
		for (const slot of this.slots) {
			this.startTermination(slot)
		}
		// Idle retirement removes a non-running slot from `slots` before asynchronous termination.
		// Snapshot the global set after starting attached slots so shutdown fences both populations.
		const results = await Promise.allSettled(this.terminations)
		const failed = results.find(
			(result): result is PromiseRejectedResult => result.status === 'rejected',
		)
		if (failed) throw failed.reason
		if (this.failure) throw this.failure
	}

	private acquireSlot(): WorkerSlot {
		for (const slot of this.slots) {
			if (slot.state !== 'idle') continue
			this.clearIdleTimer(slot)
			slot.worker.ref?.()
			return slot
		}
		if (this.slots.size >= this.options.maxThreads) {
			throw new Error('Worker thread pool capacity invariant was exceeded')
		}
		const slot: WorkerSlot = {
			worker: this.createWorker(),
			state: 'idle',
		}
		slot.worker.on('message', (message) => this.onMessage(slot, message))
		slot.worker.on('error', (error) => this.onWorkerError(slot, error))
		slot.worker.on('messageerror', (error) => this.onWorkerError(slot, error))
		slot.worker.on('exit', (code) => this.onWorkerExit(slot, code))
		this.slots.add(slot)
		return slot
	}

	private onMessage(slot: WorkerSlot, value: unknown): void {
		const task = slot.task
		if (!task || slot.state !== 'running') return
		if (!isWorkerResponse(value) || value.taskId !== task.id) {
			const error = new Error('Worker task returned an invalid response')
			this.rejectTaskResult(task, error)
			this.startTermination(slot, error)
			return
		}
		this.finishReusableTask(
			slot,
			task,
			value.ok === true ? { ok: true, value: value.value } : { ok: false, error: value.error },
		)
	}

	private onWorkerError(slot: WorkerSlot, error: Error): void {
		if (slot.state === 'terminated') return
		slot.failure = error
		if (slot.task) this.rejectTaskResult(slot.task, error)
		else if (slot.state === 'idle') this.slots.delete(slot)
		this.startTermination(slot, error)
	}

	private onWorkerExit(slot: WorkerSlot, code: number): void {
		if (slot.state === 'terminated') return
		const error =
			slot.failure ??
			(slot.state === 'terminating'
				? undefined
				: new Error(`Worker thread stopped unexpectedly with exit code ${code}`))
		this.finishTerminatedSlot(slot, error)
	}

	private abortTask(slot: WorkerSlot, task: RunningTask, reason: Error): void {
		if (slot.task !== task || slot.state !== 'running') return
		this.rejectTaskResult(task, reason)
		this.startTermination(slot)
	}

	private finishReusableTask(
		slot: WorkerSlot,
		task: RunningTask,
		outcome: Readonly<{ ok: true; value: unknown }> | Readonly<{ ok: false; error: unknown }>,
	): void {
		if (slot.task !== task || slot.state !== 'running') return
		task.signal.removeEventListener('abort', task.onAbort)
		// A normal response means this persistent Worker is already reusable. Publish that fact before
		// resolving the caller so a continuation can submit against the newly available slot.
		this.resolveTaskResource(task)
		if (outcome.ok === true) this.resolveTaskResult(task, outcome.value)
		else this.rejectTaskResult(task, outcome.error)
		slot.task = undefined
		slot.state = 'idle'
		if (this.active) {
			slot.worker.unref?.()
			this.scheduleIdleRetirement(slot)
		} else {
			this.startTermination(slot)
		}
	}

	private startTermination(slot: WorkerSlot, failure?: Error): void {
		// The task-facing resource promise and destroy() retain the failure. This branch only contains
		// the fire-and-forget starter so a rejected Worker.terminate() is not reported a second time as
		// an unhandled rejection.
		void this.terminateSlot(slot, failure).catch((): undefined => undefined)
	}

	private terminateSlot(slot: WorkerSlot, failure?: Error): Promise<void> {
		if (failure && !slot.failure) slot.failure = failure
		if (slot.state === 'terminated') return Promise.resolve()
		if (slot.termination) return slot.termination
		this.clearIdleTimer(slot)
		slot.state = 'terminating'
		slot.worker.ref?.()
		let termination!: Promise<void>
		termination = Promise.resolve()
			.then(() => slot.worker.terminate())
			.then(() => this.finishTerminatedSlot(slot, slot.failure))
			.catch((cause: unknown) => {
				const error = asError(cause, 'Worker thread termination failed')
				this.failure = error
				if (slot.task) {
					this.rejectTaskResult(slot.task, error)
					this.rejectTaskResource(slot.task, error)
				}
				throw error
			})
			.finally(() => this.terminations.delete(termination))
		slot.termination = termination
		this.terminations.add(termination)
		return termination
	}

	private finishTerminatedSlot(slot: WorkerSlot, error?: Error): void {
		if (slot.state === 'terminated') return
		this.clearIdleTimer(slot)
		slot.state = 'terminated'
		this.slots.delete(slot)
		const task = slot.task
		slot.task = undefined
		if (!task) return
		task.signal.removeEventListener('abort', task.onAbort)
		if (error) this.rejectTaskResult(task, error)
		else if (!task.resultSettled) {
			this.rejectTaskResult(task, new Error('Worker thread stopped before returning a result'))
		}
		this.resolveTaskResource(task)
	}

	private scheduleIdleRetirement(slot: WorkerSlot): void {
		this.clearIdleTimer(slot)
		slot.idleTimer = setTimeout(() => {
			slot.idleTimer = undefined
			if (slot.state !== 'idle') return
			// This Worker no longer owns a task. Free the execution slot before teardown so a new task
			// cannot fail merely because idle Worker termination has not emitted `exit` yet.
			this.slots.delete(slot)
			this.startTermination(slot)
		}, this.options.idleTimeoutMs)
		slot.idleTimer.unref?.()
	}

	private clearIdleTimer(slot: WorkerSlot): void {
		if (!slot.idleTimer) return
		clearTimeout(slot.idleTimer)
		slot.idleTimer = undefined
	}

	private resolveTaskResult(task: RunningTask, value: unknown): void {
		if (task.resultSettled) return
		task.resultSettled = true
		task.resolveResult(value)
	}

	private rejectTaskResult(task: RunningTask, reason: unknown): void {
		if (task.resultSettled) return
		task.resultSettled = true
		task.rejectResult(reason)
	}

	private resolveTaskResource(task: RunningTask): void {
		if (task.resourceSettled) return
		task.resourceSettled = true
		task.resolveSettled()
	}

	private rejectTaskResource(task: RunningTask, reason: unknown): void {
		if (task.resourceSettled) return
		task.resourceSettled = true
		task.rejectSettled(reason)
	}
}

function isWorkerResponse(value: unknown): value is WorkerResponse {
	return Boolean(
		value &&
		typeof value === 'object' &&
		typeof (value as Partial<WorkerResponse>).taskId === 'number' &&
		typeof (value as Partial<WorkerResponse>).ok === 'boolean',
	)
}

function rejectedExecution(reason: Error): WorkerThreadExecution {
	return Object.freeze({ result: Promise.reject(reason), settled: Promise.resolve() })
}

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error
		? signal.reason
		: new DOMException('Worker task aborted', 'AbortError')
}

function asError(value: unknown, fallback: string): Error {
	return value instanceof Error ? value : new Error(fallback, { cause: value })
}
