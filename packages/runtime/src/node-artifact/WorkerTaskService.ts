import { availableParallelism, cpus } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { Context as CoreContext } from '@pluxel/core'
import { Tinypool } from 'tinypool'
import type { NodeModuleDeclaration } from './node-module'
import {
	WorkerTaskError,
	type WorkerRunOptions,
	type WorkersConfig,
	type WorkerTaskDeclaration,
} from './worker-task'

const DEFAULT_MAX_QUEUED_TASKS = 128
const DEFAULT_MAX_QUEUED_TASKS_PER_PLUGIN = 32
const DEFAULT_IDLE_TIMEOUT_MS = 30_000

type ResolvedWorkersConfig = Readonly<{
	maxThreads: number
	maxQueuedTasks: number
	maxQueuedTasksPerPlugin: number
	idleTimeoutMs: number
}>

type TaskRoute = {
	url?: URL
	ready: Promise<void>
	failure?: Readonly<{ cause: unknown }>
}

type OwnerLease = {
	readonly owner: CoreContext
	readonly controller: AbortController
	readonly accepted: Set<Promise<unknown>>
	readonly queue: Set<ScheduledTask>
	queued: number
	active: boolean
	ready: boolean
}

type ScheduledTask = {
	readonly owner: OwnerLease
	filename?: string
	input?: unknown
	transferList?: ArrayBuffer[]
	readonly signal: AbortSignal
	readonly disposeSignal: () => void
	readonly resolve: (value: unknown) => void
	readonly reject: (reason: unknown) => void
	abortListener?: () => void
	state: 'resolving' | 'queued' | 'running' | 'settled'
}

type RootState = {
	readonly config: ResolvedWorkersConfig
	readonly owners: Map<CoreContext, OwnerLease>
	readonly readyOwners: Set<OwnerLease>
	pool?: Tinypool
	activeTasks: number
	queuedTasks: number
	lastOwner?: OwnerLease
	shuttingDown: boolean
}

type WorkerInputSnapshot = Readonly<{
	input: unknown
	transferList?: ArrayBuffer[]
}>

type TinypoolRunOptions = NonNullable<Parameters<Tinypool['run']>[1]>
type TinypoolTransferList = NonNullable<TinypoolRunOptions['transferList']>

const rootStates = new WeakMap<WorkerTaskService, RootState>()

export class WorkerTaskService {
	private readonly routes = new WeakMap<object, TaskRoute>()
	private state?: RootState

	constructor(
		public readonly ctx: CoreContext,
		config: WorkersConfig | undefined,
	) {
		if (ctx === ctx.root) {
			this.state = {
				config: resolveWorkersConfig(config),
				owners: new Map(),
				readyOwners: new Set(),
				activeTasks: 0,
				queuedTasks: 0,
				shuttingDown: false,
			}
			rootStates.set(this, this.state)
			ctx.effects.defer(() => this.shutdownRoot(), {
				tag: 'WorkerTasks',
				phase: 'shutdown',
			})
		}
	}

	/** Run a cloneable task within the host's shared worker-thread budget. */
	run<Input, Output>(
		declaration: WorkerTaskDeclaration<Input, Output>,
		input: Input,
		options: WorkerRunOptions = {},
	): Promise<Output> {
		if (!declaration || typeof declaration !== 'object') {
			return Promise.reject(
				new WorkerTaskError('TASK_UNAVAILABLE', 'workers.run() requires a worker task declaration'),
			)
		}
		if (!options || typeof options !== 'object') {
			return Promise.reject(
				new WorkerTaskError('INVALID_INPUT', 'workers.run() options must be an object'),
			)
		}

		let lease: OwnerLease
		let route: TaskRoute
		let state: RootState
		try {
			lease = this.ownerLease()
			state = this.rootState()
			if (options.signal?.aborted) throw abortReason(options.signal)
			route = this.taskRoute(declaration)
			if (route.failure) throw taskUnavailable(route.failure.cause)
			const mustWait = route.url === undefined || state.activeTasks >= state.config.maxThreads
			if (mustWait) this.assertQueueCapacity(state, lease)
		} catch (cause) {
			return Promise.reject(cause)
		}

		let snapshot: WorkerInputSnapshot
		try {
			snapshot = snapshotWorkerInput(input, options.transfer)
		} catch (cause) {
			return Promise.reject(invalidWorkerInput(cause))
		}
		const task = this.submit(state, lease, route, snapshot, options.signal)
		lease.accepted.add(task)
		void task.then(
			() => lease.accepted.delete(task),
			() => lease.accepted.delete(task),
		)
		return task as Promise<Output>
	}

	private taskRoute<Input, Output>(declaration: WorkerTaskDeclaration<Input, Output>): TaskRoute {
		const key = declaration as object
		const existing = this.routes.get(key)
		if (existing) return existing
		const route = {} as TaskRoute
		route.ready = this.ctx.nodeModules
			.use(declaration as unknown as NodeModuleDeclaration, (url) => void (route.url = url))
			.catch((cause: unknown) => {
				route.failure = Object.freeze({ cause })
			})
		this.routes.set(key, route)
		return route
	}

	private ownerLease(): OwnerLease {
		const state = this.rootState()
		if (state.shuttingDown) {
			throw new WorkerTaskError('NOT_RUNNING', 'Worker task service is shutting down')
		}
		const owner = this.ctx.caller ?? this.ctx
		const existing = state.owners.get(owner)
		if (existing) {
			if (!existing.active) {
				throw new WorkerTaskError('NOT_RUNNING', 'Worker task owner has stopped')
			}
			return existing
		}
		const lease: OwnerLease = {
			owner,
			controller: new AbortController(),
			accepted: new Set(),
			queue: new Set(),
			queued: 0,
			active: true,
			ready: false,
		}
		state.owners.set(owner, lease)
		try {
			owner.effects.defer(() => this.closeOwner(state, lease), {
				tag: 'WorkerTaskOwner',
				phase: 'shutdown',
			})
		} catch (cause) {
			state.owners.delete(owner)
			lease.active = false
			throw new WorkerTaskError('NOT_RUNNING', 'Worker task owner is stopping', { cause })
		}
		return lease
	}

	private assertQueueCapacity(state: RootState, owner: OwnerLease): void {
		const availableExecutionSlots = Math.max(0, state.config.maxThreads - state.activeTasks)
		if (state.queuedTasks >= state.config.maxQueuedTasks + availableExecutionSlots) {
			throw new WorkerTaskError(
				'QUEUE_FULL',
				`Worker task queue reached its ${state.config.maxQueuedTasks} task limit`,
			)
		}
		if (owner.queued >= state.config.maxQueuedTasksPerPlugin + availableExecutionSlots) {
			throw new WorkerTaskError(
				'OWNER_QUEUE_FULL',
				`Plugin worker queue reached its ${state.config.maxQueuedTasksPerPlugin} task limit`,
			)
		}
	}

	private submit(
		state: RootState,
		owner: OwnerLease,
		route: TaskRoute,
		snapshot: WorkerInputSnapshot,
		signal: AbortSignal | undefined,
	): Promise<unknown> {
		if (!owner.active || state.shuttingDown) {
			return Promise.reject(new WorkerTaskError('NOT_RUNNING', 'Worker task owner has stopped'))
		}

		const linked = linkAbortSignals([owner.controller.signal, signal])
		if (linked.signal.aborted) {
			linked.dispose()
			return Promise.reject(abortReason(linked.signal))
		}
		return new Promise<unknown>((resolve, reject) => {
			const task: ScheduledTask = {
				owner,
				input: snapshot.input,
				...(snapshot.transferList === undefined ? {} : { transferList: snapshot.transferList }),
				signal: linked.signal,
				disposeSignal: linked.dispose,
				resolve,
				reject,
				state: route.url === undefined ? 'resolving' : 'queued',
			}
			task.abortListener = () => this.cancelWaiting(state, task)
			linked.signal.addEventListener('abort', task.abortListener, { once: true })
			owner.queued++
			state.queuedTasks++
			if (route.url) {
				task.filename = fileURLToPath(route.url)
				owner.queue.add(task)
				this.enqueueReadyOwner(state, owner)
				this.drain(state)
				return
			}
			void route.ready.then((): undefined => {
				if (route.failure) {
					this.failResolvingTask(state, task, taskUnavailable(route.failure.cause))
					return undefined
				}
				this.activateResolvedTask(state, task, route)
				return undefined
			})
		})
	}

	private activateResolvedTask(state: RootState, task: ScheduledTask, route: TaskRoute): void {
		if (task.state !== 'resolving') return
		if (!route.url) {
			this.failResolvingTask(
				state,
				task,
				new WorkerTaskError(
					'TASK_UNAVAILABLE',
					'Worker task artifact resolver completed without a module URL',
				),
			)
			return
		}
		task.filename = fileURLToPath(route.url)
		task.state = 'queued'
		task.owner.queue.add(task)
		this.enqueueReadyOwner(state, task.owner)
		this.drain(state)
	}

	private failResolvingTask(state: RootState, task: ScheduledTask, error: unknown): void {
		if (task.state !== 'resolving') return
		task.owner.queued--
		state.queuedTasks--
		this.settle(task, error)
		this.drain(state)
	}

	private drain(state: RootState): void {
		while (
			!state.shuttingDown &&
			state.activeTasks < state.config.maxThreads &&
			state.queuedTasks > 0
		) {
			const owner = this.nextReadyOwner(state)
			if (!owner) return
			const task = this.dequeueTask(owner)
			if (!task || task.state !== 'queued') {
				continue
			}
			owner.queued--
			state.queuedTasks--
			if (owner.queue.size > 0) this.enqueueReadyOwner(state, owner)
			this.dispatch(state, task)
		}
	}

	private nextReadyOwner(state: RootState): OwnerLease | undefined {
		while (state.readyOwners.size > 0) {
			let owner = firstSetValue(state.readyOwners)!
			this.removeReadyOwner(state, owner)
			if (
				owner === state.lastOwner &&
				state.readyOwners.size > 0 &&
				owner.active &&
				owner.queue.size > 0
			) {
				this.enqueueReadyOwner(state, owner)
				owner = firstSetValue(state.readyOwners)!
				this.removeReadyOwner(state, owner)
			}
			if (owner.active && owner.queue.size > 0) return owner
		}
		return undefined
	}

	private dispatch(state: RootState, task: ScheduledTask): void {
		task.state = 'running'
		state.activeTasks++
		state.lastOwner = task.owner
		let execution: Promise<unknown>
		try {
			const pool = (state.pool ??= createPool(state.config))
			execution = pool.run(task.input, {
				filename: task.filename!,
				name: 'default',
				signal: task.signal,
				...(task.transferList === undefined
					? {}
					: { transferList: asTinypoolTransferList(task.transferList) }),
			})
			task.input = undefined
			task.transferList = undefined
			task.filename = undefined
		} catch (cause) {
			this.settle(task, workerExecutionError(cause))
			state.activeTasks--
			this.drain(state)
			return
		}
		void execution.then(
			(value): undefined => {
				state.activeTasks--
				this.settle(task, undefined, value)
				this.drain(state)
				return undefined
			},
			(cause): undefined => {
				const error = task.signal.aborted ? abortReason(task.signal) : workerExecutionError(cause)
				state.activeTasks--
				this.settle(task, error)
				this.drain(state)
				return undefined
			},
		)
	}

	private cancelWaiting(state: RootState, task: ScheduledTask): void {
		if (task.state !== 'resolving' && task.state !== 'queued') return
		if (task.state === 'queued') task.owner.queue.delete(task)
		task.owner.queued--
		state.queuedTasks--
		if (task.owner.queue.size === 0) this.removeReadyOwner(state, task.owner)
		this.settle(task, abortReason(task.signal))
		this.drain(state)
	}

	private removeReadyOwner(state: RootState, owner: OwnerLease): void {
		if (!owner.ready) return
		state.readyOwners.delete(owner)
		owner.ready = false
	}

	private enqueueReadyOwner(state: RootState, owner: OwnerLease): void {
		if (owner.ready || !owner.active || owner.queue.size === 0) return
		owner.ready = true
		state.readyOwners.add(owner)
	}

	private dequeueTask(owner: OwnerLease): ScheduledTask | undefined {
		const task = firstSetValue(owner.queue)
		if (!task) return undefined
		owner.queue.delete(task)
		return task
	}

	private settle(task: ScheduledTask, error?: unknown, value?: unknown): void {
		if (task.state === 'settled') return
		task.state = 'settled'
		if (task.abortListener) task.signal.removeEventListener('abort', task.abortListener)
		task.disposeSignal()
		task.input = undefined
		task.transferList = undefined
		task.filename = undefined
		if (error === undefined) task.resolve(value)
		else task.reject(error)
	}

	private async closeOwner(state: RootState, lease: OwnerLease): Promise<void> {
		if (!lease.active) return
		lease.active = false
		lease.controller.abort(
			new WorkerTaskError('NOT_RUNNING', 'Worker task owner stopped before work completed'),
		)
		this.removeReadyOwner(state, lease)
		lease.queue.clear()
		await Promise.allSettled(lease.accepted)
		state.owners.delete(lease.owner)
	}

	private rootState(): RootState {
		const root = this.ctx.root.workers as WorkerTaskService
		const state = root.state ?? rootStates.get(root)
		if (!state) throw new WorkerTaskError('NOT_RUNNING', 'Worker task root is unavailable')
		return state
	}

	private async shutdownRoot(): Promise<void> {
		const state = this.state
		if (!state || state.shuttingDown) return
		state.shuttingDown = true
		for (const lease of state.owners.values()) {
			if (!lease.active) continue
			lease.active = false
			lease.controller.abort(
				new WorkerTaskError('NOT_RUNNING', 'Worker task root is shutting down'),
			)
		}
		const accepted: Promise<unknown>[] = []
		for (const lease of state.owners.values()) {
			for (const task of lease.accepted) accepted.push(task)
		}
		await Promise.allSettled(accepted)
		state.owners.clear()
		state.readyOwners.clear()
		await state.pool?.destroy()
		state.pool = undefined
	}
}

function asTinypoolTransferList(transferList: ArrayBuffer[]): TinypoolTransferList {
	// Tinypool accepts Node's transfer-list array at runtime. Under @types/node 26 its
	// conditional type selects the newer postMessage options overload instead.
	return transferList as unknown as TinypoolTransferList
}

function firstSetValue<T>(values: ReadonlySet<T>): T | undefined {
	return values.values().next().value
}

function createPool(config: ResolvedWorkersConfig): Tinypool {
	return new Tinypool({
		minThreads: 0,
		maxThreads: config.maxThreads,
		// Only one startup/handoff wave is allowed below the owner-fair public queue.
		maxQueue: config.maxThreads,
		concurrentTasksPerWorker: 1,
		idleTimeout: config.idleTimeoutMs,
		isolateWorkers: false,
		runtime: 'worker_threads',
	})
}

function snapshotWorkerInput(
	input: unknown,
	transfer: readonly ArrayBuffer[] | undefined,
): WorkerInputSnapshot {
	if (transfer === undefined) return Object.freeze({ input: structuredClone(input) })
	if (!Array.isArray(transfer)) throw new TypeError('workers.run() transfer must be an array')
	const transferList = [...transfer]
	const unique = new Set<ArrayBuffer>()
	for (const buffer of transferList) {
		if (!(buffer instanceof ArrayBuffer)) {
			throw new TypeError('workers.run() transfer accepts only ArrayBuffer values')
		}
		if (unique.has(buffer)) {
			throw new TypeError('workers.run() transfer must not contain duplicate ArrayBuffers')
		}
		unique.add(buffer)
	}
	if (transferList.length === 0) return Object.freeze({ input: structuredClone(input) })
	const snapshot = structuredClone(
		{ input, transferList },
		{ transfer: transferList },
	) as Readonly<{ input: unknown; transferList: ArrayBuffer[] }>
	return Object.freeze({ input: snapshot.input, transferList: snapshot.transferList })
}

function invalidWorkerInput(cause: unknown): WorkerTaskError {
	return new WorkerTaskError(
		'INVALID_INPUT',
		'Worker task input must be compatible with structured clone and its transfer list',
		{ cause },
	)
}

function taskUnavailable(cause: unknown): WorkerTaskError {
	return cause instanceof WorkerTaskError
		? cause
		: new WorkerTaskError('TASK_UNAVAILABLE', 'Worker task artifact is unavailable', { cause })
}

function workerExecutionError(cause: unknown): WorkerTaskError {
	return isDataCloneError(cause)
		? invalidWorkerInput(cause)
		: new WorkerTaskError('TASK_FAILED', 'Worker task failed', { cause })
}

function isDataCloneError(cause: unknown): boolean {
	return cause instanceof DOMException
		? cause.name === 'DataCloneError'
		: Boolean(
				cause &&
				typeof cause === 'object' &&
				(cause as { name?: unknown }).name === 'DataCloneError',
			)
}

function resolveWorkersConfig(input: WorkersConfig | undefined): ResolvedWorkersConfig {
	const parallelism =
		(typeof availableParallelism === 'function' ? availableParallelism() : cpus().length) || 1
	const defaults = Math.max(1, Math.min(4, parallelism - 1 || 1))
	return Object.freeze({
		maxThreads: boundedInteger(input?.maxThreads, defaults, 1, 256, 'maxThreads'),
		maxQueuedTasks: boundedInteger(
			input?.maxQueuedTasks,
			DEFAULT_MAX_QUEUED_TASKS,
			1,
			1_000_000,
			'maxQueuedTasks',
		),
		maxQueuedTasksPerPlugin: boundedInteger(
			input?.maxQueuedTasksPerPlugin,
			DEFAULT_MAX_QUEUED_TASKS_PER_PLUGIN,
			1,
			1_000_000,
			'maxQueuedTasksPerPlugin',
		),
		idleTimeoutMs: boundedInteger(
			input?.idleTimeoutMs,
			DEFAULT_IDLE_TIMEOUT_MS,
			0,
			3_600_000,
			'idleTimeoutMs',
		),
	})
}

function boundedInteger(
	value: number | undefined,
	fallback: number,
	minimum: number,
	maximum: number,
	name: string,
): number {
	const resolved = value ?? fallback
	if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
		throw new RangeError(
			`[pluxel/runtime] workers.${name} must be an integer from ${minimum} through ${maximum}`,
		)
	}
	return resolved
}

function linkAbortSignals(signals: readonly (AbortSignal | undefined)[]): Readonly<{
	signal: AbortSignal
	dispose(): void
}> {
	const controller = new AbortController()
	const listeners: Array<Readonly<{ signal: AbortSignal; listener: () => void }>> = []
	for (const signal of signals) {
		if (!signal) continue
		if (signal.aborted) {
			controller.abort(signal.reason)
			break
		}
		const listener = () => controller.abort(signal.reason)
		signal.addEventListener('abort', listener, { once: true })
		listeners.push({ signal, listener })
	}
	return {
		signal: controller.signal,
		dispose() {
			for (const { signal, listener } of listeners) signal.removeEventListener('abort', listener)
		},
	}
}

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error
		? signal.reason
		: new DOMException('Worker task aborted', 'AbortError')
}
