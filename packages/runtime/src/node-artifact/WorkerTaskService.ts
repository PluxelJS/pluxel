import { availableParallelism, cpus } from 'node:os'
import { fileURLToPath } from 'node:url'
import { Injectable, type Context as CoreContext } from '@pluxel/core'
import { Tinypool } from 'tinypool'
import type { NodeModuleDeclaration } from './node-module'
import {
	WorkerTaskError,
	type WorkerRunOptions,
	type WorkersConfig,
	type WorkerTaskDeclaration,
} from './worker-task'

const serviceName = 'workers' as const

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
}

type OwnerLease = {
	readonly owner: CoreContext
	readonly controller: AbortController
	readonly accepted: Set<Promise<unknown>>
	readonly queue: ScheduledTask[]
	queued: number
	active: boolean
	ready: boolean
}

type ScheduledTask = {
	readonly owner: OwnerLease
	readonly filename: string
	readonly input: unknown
	readonly signal: AbortSignal
	readonly disposeSignal: () => void
	readonly resolve: (value: unknown) => void
	readonly reject: (reason: unknown) => void
	abortListener?: () => void
	state: 'queued' | 'running' | 'settled'
}

type RootState = {
	readonly config: ResolvedWorkersConfig
	readonly owners: Map<CoreContext, OwnerLease>
	readonly readyOwners: OwnerLease[]
	pool?: Tinypool
	activeTasks: number
	queuedTasks: number
	lastOwner?: OwnerLease
	shuttingDown: boolean
}

const rootStates = new WeakMap<WorkerTaskService, RootState>()

declare module '@pluxel/core' {
	namespace Context {
		interface Services {
			[serviceName]: WorkerTaskService
		}
		interface Config {
			/** Root-owned shared pool for cloneable CPU/native worker tasks. */
			workers?: WorkersConfig
		}
	}
}

@Injectable({ key: serviceName })
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
				readyOwners: [],
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
		let cloned: Input
		try {
			cloned = structuredClone(input)
		} catch (cause) {
			return Promise.reject(
				new WorkerTaskError(
					'INVALID_INPUT',
					'Worker task input must be compatible with the structured clone algorithm',
					{ cause },
				),
			)
		}

		let lease: OwnerLease
		try {
			lease = this.ownerLease()
		} catch (cause) {
			return Promise.reject(cause)
		}
		const task = this.resolveAndSubmit(declaration, cloned, lease, options.signal)
		lease.accepted.add(task)
		void task.then(
			() => lease.accepted.delete(task),
			() => lease.accepted.delete(task),
		)
		return task
	}

	private async resolveAndSubmit<Input, Output>(
		declaration: WorkerTaskDeclaration<Input, Output>,
		input: Input,
		lease: OwnerLease,
		signal: AbortSignal | undefined,
	): Promise<Output> {
		const linked = linkAbortSignals([lease.controller.signal, signal])
		try {
			if (linked.signal.aborted) throw abortReason(linked.signal)
			const route = this.taskRoute(declaration)
			await waitForSignal(route.ready, linked.signal)
			if (!route.url) {
				throw new WorkerTaskError(
					'TASK_UNAVAILABLE',
					'Worker task artifact resolver completed without a module URL',
				)
			}
			return (await this.submit(lease, fileURLToPath(route.url), input, linked.signal)) as Output
		} catch (cause) {
			if (linked.signal.aborted) throw abortReason(linked.signal)
			if (cause instanceof WorkerTaskError) throw cause
			throw new WorkerTaskError('TASK_UNAVAILABLE', 'Worker task artifact is unavailable', {
				cause,
			})
		} finally {
			linked.dispose()
		}
	}

	private taskRoute<Input, Output>(declaration: WorkerTaskDeclaration<Input, Output>): TaskRoute {
		const key = declaration as object
		const existing = this.routes.get(key)
		if (existing) return existing
		const route = {} as TaskRoute
		route.ready = this.ctx.nodeModules.use(
			declaration as unknown as NodeModuleDeclaration,
			(url) => void (route.url = url),
		)
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
			queue: [],
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

	private submit(
		owner: OwnerLease,
		filename: string,
		input: unknown,
		signal: AbortSignal,
	): Promise<unknown> {
		const state = this.rootState()
		if (!owner.active || state.shuttingDown) {
			return Promise.reject(new WorkerTaskError('NOT_RUNNING', 'Worker task owner has stopped'))
		}
		if (signal.aborted) return Promise.reject(abortReason(signal))
		const mustWait = state.activeTasks >= state.config.maxThreads
		if (mustWait && state.queuedTasks >= state.config.maxQueuedTasks) {
			return Promise.reject(
				new WorkerTaskError(
					'QUEUE_FULL',
					`Worker task queue reached its ${state.config.maxQueuedTasks} task limit`,
				),
			)
		}
		if (mustWait && owner.queued >= state.config.maxQueuedTasksPerPlugin) {
			return Promise.reject(
				new WorkerTaskError(
					'OWNER_QUEUE_FULL',
					`Plugin worker queue reached its ${state.config.maxQueuedTasksPerPlugin} task limit`,
				),
			)
		}

		const linked = linkAbortSignals([owner.controller.signal, signal])
		return new Promise<unknown>((resolve, reject) => {
			const task: ScheduledTask = {
				owner,
				filename,
				input,
				signal: linked.signal,
				disposeSignal: linked.dispose,
				resolve,
				reject,
				state: 'queued',
			}
			task.abortListener = () => this.cancelQueued(state, task)
			linked.signal.addEventListener('abort', task.abortListener, { once: true })
			owner.queue.push(task)
			owner.queued++
			state.queuedTasks++
			if (!owner.ready) {
				owner.ready = true
				state.readyOwners.push(owner)
			}
			this.drain(state)
		})
	}

	private drain(state: RootState): void {
		while (
			!state.shuttingDown &&
			state.activeTasks < state.config.maxThreads &&
			state.queuedTasks > 0
		) {
			const owner = this.nextReadyOwner(state)
			if (!owner) return
			let task: ScheduledTask | undefined
			while ((task = owner.queue.shift())) {
				if (task.state === 'queued') break
			}
			if (!task || task.state !== 'queued') {
				owner.ready = false
				continue
			}
			owner.queued--
			state.queuedTasks--
			if (owner.queued > 0) state.readyOwners.push(owner)
			else owner.ready = false
			this.dispatch(state, task)
		}
	}

	private nextReadyOwner(state: RootState): OwnerLease | undefined {
		while (state.readyOwners.length > 0) {
			if (
				state.readyOwners.length > 1 &&
				state.lastOwner &&
				state.readyOwners[0] === state.lastOwner
			) {
				state.readyOwners.push(state.readyOwners.shift()!)
			}
			const owner = state.readyOwners.shift()!
			if (owner.active && owner.queued > 0) return owner
			owner.ready = false
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
				filename: task.filename,
				name: 'default',
				signal: task.signal,
				runtime: 'worker_threads',
			})
		} catch (cause) {
			this.settle(task, new WorkerTaskError('TASK_FAILED', 'Worker task failed', { cause }))
			state.activeTasks--
			this.drain(state)
			return
		}
		void execution
			.then(
				(value) => this.settle(task, undefined, value),
				(cause) => {
					const error = task.signal.aborted
						? abortReason(task.signal)
						: new WorkerTaskError('TASK_FAILED', 'Worker task failed', { cause })
					this.settle(task, error)
				},
			)
			.finally(() => {
				state.activeTasks--
				this.drain(state)
			})
	}

	private cancelQueued(state: RootState, task: ScheduledTask): void {
		if (task.state !== 'queued') return
		task.owner.queued--
		state.queuedTasks--
		if (task.owner.queued === 0) this.removeReadyOwner(state, task.owner)
		this.settle(task, abortReason(task.signal))
		this.drain(state)
	}

	private removeReadyOwner(state: RootState, owner: OwnerLease): void {
		owner.ready = false
		for (let index = state.readyOwners.length - 1; index >= 0; index--) {
			if (state.readyOwners[index] === owner) state.readyOwners.splice(index, 1)
		}
	}

	private settle(task: ScheduledTask, error?: unknown, value?: unknown): void {
		if (task.state === 'settled') return
		task.state = 'settled'
		if (task.abortListener) task.signal.removeEventListener('abort', task.abortListener)
		task.disposeSignal()
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
		lease.queue.length = 0
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
		state.readyOwners.length = 0
		await state.pool?.destroy()
		state.pool = undefined
	}
}

/** @internal Keep owner-bearing worker task views isolated per plugin Context. */
export function withWorkerTaskPluginContext<T extends CoreContext.Config>(config: T): T {
	const registry =
		config.registry && typeof config.registry === 'object'
			? (config.registry as Record<string, unknown>)
			: {}
	const current = Array.isArray(registry.pluginCTXIsolate)
		? (registry.pluginCTXIsolate as unknown[])
		: []
	if (current.includes(WorkerTaskService)) return config
	return {
		...config,
		registry: {
			...registry,
			pluginCTXIsolate: [...current, WorkerTaskService],
		},
	} as T
}

function createPool(config: ResolvedWorkersConfig): Tinypool {
	return new Tinypool({
		minThreads: 0,
		maxThreads: config.maxThreads,
		maxQueue: config.maxThreads,
		concurrentTasksPerWorker: 1,
		idleTimeout: config.idleTimeoutMs,
		isolateWorkers: false,
		runtime: 'worker_threads',
	})
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

async function waitForSignal<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) throw abortReason(signal)
	let rejectAbort!: (reason: unknown) => void
	const aborted = new Promise<never>((_resolve, reject) => void (rejectAbort = reject))
	const listener = () => rejectAbort(abortReason(signal))
	signal.addEventListener('abort', listener, { once: true })
	try {
		return await Promise.race([task, aborted])
	} finally {
		signal.removeEventListener('abort', listener)
	}
}

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error
		? signal.reason
		: new DOMException('Worker task aborted', 'AbortError')
}
