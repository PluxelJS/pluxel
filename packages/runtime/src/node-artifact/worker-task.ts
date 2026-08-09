import { createNodeModuleDeclaration } from './node-module'

declare const workerTaskBrand: unique symbol

/** A separately-built Node worker entry whose default export handles one cloneable input value. */
export type WorkerTaskDeclaration<Input = unknown, Output = unknown> = Readonly<{
	[workerTaskBrand]: (input: Input) => Output
}>

/** The default export contract implemented by a declared worker entry. */
export type WorkerTaskHandler<Input, Output> = (input: Input) => Output | Promise<Output>

export type WorkerTaskErrorCode =
	| 'NOT_RUNNING'
	| 'QUEUE_FULL'
	| 'OWNER_QUEUE_FULL'
	| 'INVALID_INPUT'
	| 'TASK_UNAVAILABLE'
	| 'TASK_FAILED'

/** Stable failure raised by shared worker admission, artifact resolution, or execution. */
export class WorkerTaskError extends Error {
	override readonly name = 'WorkerTaskError'

	constructor(
		readonly code: WorkerTaskErrorCode,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options)
	}
}

export type WorkerRunOptions = Readonly<{
	/** Cancels queued work or terminates the worker executing this task. */
	signal?: AbortSignal
	/**
	 * Moves these input `ArrayBuffer`s into the task snapshot instead of copying their bytes.
	 * Accepted buffers are detached synchronously and ownership is not restored when later work fails.
	 * Omission snapshots the complete input with the structured clone algorithm.
	 */
	transfer?: readonly ArrayBuffer[]
}>

export type WorkersConfig = Readonly<{
	/** Shared root thread budget. Defaults to min(4, available CPUs minus one). */
	maxThreads?: number
	/** Waiting jobs across all plugin owners. Running jobs do not count. @defaultValue 128 */
	maxQueuedTasks?: number
	/** Waiting jobs owned by one plugin Context. @defaultValue 32 */
	maxQueuedTasksPerPlugin?: number
	/** Retires idle threads and their loaded module caches. @defaultValue 30000 */
	idleTimeoutMs?: number
}>

/** Declare a module-level worker task for `ctx.workers.run()`. */
export function defineWorkerTask<Input, Output>(
	moduleUrl: string | URL,
	entryPath: string,
): WorkerTaskDeclaration<Input, Output> {
	return createNodeModuleDeclaration(
		moduleUrl,
		entryPath,
		arguments[2],
		'defineWorkerTask',
	) as unknown as WorkerTaskDeclaration<Input, Output>
}
