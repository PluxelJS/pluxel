import type { PluginLifecycleAdapter } from '../composition/BasePlugin'
import { LATE_INIT_CLEANUP_ERROR } from '../composition/symbols'

/* ────────────────────────── 外部事件 ────────────────────────── */
export type LifecycleEvent =
	| { type: 'START' }
	| { type: 'STOP' }
	| { type: 'ASYNC_ERROR'; error: unknown }

/* ────────────────────────── 机器输入 & 上下文 ────────────────────────── */

export interface LifecycleInput {
	id: unknown
	runtime: PluginLifecycleAdapter
}

type FailedStep = 'start' | 'drain' | 'runtime' | undefined

interface LifecycleCtx extends LifecycleInput {
	attempt: number // 连续失败次数（成功后清零）
	err?: Error // 最近一次错误（保真 Error）
	startedAt?: number // 首次成功启动时间戳
	failedStep: FailedStep // 失败发生在哪个阶段
}

/* ────────────────────────── 选项 ────────────────────────── */
export interface LifecycleOptions {
	/** Receives init settlement errors after stop/drain has already won the generation. */
	onLateError?: (error: unknown, phase: 'start' | 'drain') => void
}

export interface LifecycleSnapshot {
	value: LifecycleState
	context: LifecycleCtx
	status?: 'stopped'
}

type Observer<T> = { next?: (value: T) => void; error?: (err: unknown) => void }

/** 循环安全的 JSON 序列化（尽量给出可读 message） */
function safeStringify(x: unknown): string {
	if (typeof x !== 'object' || x === null) {
		if (typeof x === 'string') return x
		try {
			const json = JSON.stringify(x)
			return json ?? String(x)
		} catch {
			return String(x)
		}
	}
	try {
		const seen = new WeakSet<object>()
		return JSON.stringify(
			x,
			(_, v) => {
				if (typeof v === 'object' && v !== null) {
					if (seen.has(v)) return '[Circular]'
					seen.add(v)
				}
				return v
			},
			2,
		)
	} catch {
		return Object.prototype.toString.call(x)
	}
}

/** 把任意值转为 Error，并把原值塞到 cause */
const toError = (e: unknown): Error => {
	if (e instanceof Error) return e
	const msg = typeof e === 'string' ? e : safeStringify(e)

	return new Error(msg, { cause: e })
}

const enum State {
	Idle,
	Starting,
	Running,
	Stopping,
	Failing,
	Stopped,
}
const enum Event {
	Start,
	Started,
	Failed,
	Stop,
	Drained,
	AsyncError,
}
const stateNames = ['idle', 'starting', 'running', 'stopping', 'failing', 'stopped'] as const
const eventNames = ['start', 'started', 'failed', 'stop', 'drained', 'asyncError'] as const
type LifecycleState = (typeof stateNames)[number]
type TransitionEvent = Event
const eventCount = 6
const invalid = -1
// One table for all generations; rows are states, columns are events in the order above.
// prettier-ignore
const transitions = new Int8Array([
  State.Starting, invalid, invalid, State.Stopping, invalid, invalid, // idle
  invalid, State.Running, State.Failing, State.Stopping, invalid, invalid, // starting
  invalid, invalid, invalid, State.Stopping, invalid, State.Failing, // running
  invalid, invalid, invalid, invalid, State.Stopped, invalid, // stopping
  invalid, invalid, invalid, State.Stopping, invalid, invalid, // failing
  invalid, invalid, invalid, invalid, invalid, invalid, // stopped
])

const settled = Promise.resolve()

export class PluginLifecycleActor {
	private readonly ctx: LifecycleCtx
	private readonly opts: LifecycleOptions
	private readonly listeners = new Set<Observer<LifecycleSnapshot>>()
	private snapshot: LifecycleSnapshot
	private queue = settled
	private errorUnsub: (() => void) | undefined
	private startAbort: AbortController | null = null
	private pendingStop = false
	private drainTask: Promise<void> | null = null
	private drainError: unknown
	private state: State = State.Idle

	constructor(opts: LifecycleOptions, input: LifecycleInput) {
		this.opts = opts
		this.ctx = {
			id: input.id,
			runtime: input.runtime,
			attempt: 0,
			err: undefined,
			startedAt: undefined,
			failedStep: undefined,
		}

		this.snapshot = this.buildSnapshot()
	}

	private async startRuntime(): Promise<void> {
		const abort = (this.startAbort = new AbortController())
		const { runtime } = this.ctx
		try {
			// A stop queued before START runs must not admit init.
			if (this.pendingStop) {
				abort.abort()
				return
			}
			if (runtime.init) await runtime.init(abort.signal)
			if (abort.signal.aborted || this.pendingStop) return
			if (runtime.finalize) await runtime.finalize(abort.signal)
			if (abort.signal.aborted || this.pendingStop) return
			if (!this.ctx.startedAt) this.ctx.startedAt = Date.now()
			this.ctx.err = undefined
			this.ctx.attempt = 0
			this.ctx.failedStep = undefined
			if (this.state === State.Starting) await this.dispatch(Event.Started)
		} catch (error) {
			if (abort.signal.aborted && this.pendingStop) {
				const phase =
					error &&
					typeof error === 'object' &&
					(error as { [LATE_INIT_CLEANUP_ERROR]?: unknown })[LATE_INIT_CLEANUP_ERROR]
						? 'drain'
						: 'start'
				this.opts.onLateError?.(error, phase)
				return
			}
			this.ctx.err = toError(error)
			this.ctx.failedStep = 'start'
			this.ctx.attempt++
			if (this.state === State.Starting) await this.dispatch(Event.Failed)
		} finally {
			this.startAbort = null
		}
	}

	private async stopRuntime(): Promise<void> {
		this.pendingStop = true
		this.startAbort?.abort()
		await this.beginDrain()
		if (this.drainError !== undefined) {
			if (!this.ctx.err) this.ctx.err = toError(this.drainError)
			if (!this.ctx.failedStep) this.ctx.failedStep = 'drain'
			this.ctx.attempt++
		}
		await this.dispatch(Event.Drained)
		this.pendingStop = false
	}

	private unsubscribeErrors(): void {
		try {
			this.errorUnsub?.()
		} catch {
			// Error channel teardown must not prevent generation drain.
		}
		this.errorUnsub = undefined
	}

	getSnapshot(): LifecycleSnapshot {
		return this.snapshot
	}

	subscribe(observer: Observer<LifecycleSnapshot> | ((s: LifecycleSnapshot) => void)) {
		const obs: Observer<LifecycleSnapshot> =
			typeof observer === 'function' ? { next: observer } : observer
		this.listeners.add(obs)
		return {
			unsubscribe: () => {
				this.listeners.delete(obs)
			},
		}
	}

	waitUntil(
		predicate: (snapshot: LifecycleSnapshot) => boolean,
		timeoutMs?: number,
	): Promise<LifecycleSnapshot> {
		const current = this.getSnapshot()
		if (predicate(current)) return Promise.resolve(current)

		return new Promise((resolve, reject) => {
			let done = false
			let timer: ReturnType<typeof setTimeout> | undefined

			const sub = this.subscribe((snapshot: LifecycleSnapshot) => {
				if (done || !predicate(snapshot)) return
				done = true
				cleanup()
				resolve(snapshot)
			})

			const cleanup = () => {
				if (timer) clearTimeout(timer)
				sub.unsubscribe()
			}

			if (timeoutMs !== null && timeoutMs !== undefined) {
				timer = setTimeout(() => {
					if (done) return
					done = true
					cleanup()
					reject(new Error(`Timed out after ${timeoutMs}ms`))
				}, timeoutMs)
			}
		})
	}

	waitForStable(timeoutMs?: number): Promise<LifecycleSnapshot> {
		return this.waitUntil(lifecycleSelectors.isStable, timeoutMs)
	}

	waitForStopped(timeoutMs?: number): Promise<LifecycleSnapshot> {
		return this.waitUntil(lifecycleSelectors.isStopped, timeoutMs)
	}

	send(event: LifecycleEvent): void {
		const current = this.state
		if (event.type === 'STOP') {
			if (this.pendingStop || current === State.Stopped || current === State.Stopping) return
			this.pendingStop = true
			// Abort in-flight init immediately; waiting for the STOP transition can be too late
			// because startRuntime awaits init() and blocks the event queue.
			if (this.startAbort) {
				try {
					this.startAbort.abort()
				} catch {
					/* ignore */
				}
			}
			void this.beginDrain()
		}
		if (event.type === 'START' && (current === State.Running || current === State.Starting)) return
		this.queue = this.queue
			.then(() =>
				this.dispatch(
					event.type === 'START'
						? Event.Start
						: event.type === 'STOP'
							? Event.Stop
							: Event.AsyncError,
					event.type === 'ASYNC_ERROR' ? event.error : undefined,
				),
			)
			.catch((err) => {
				this.notifyError(err)
			})
	}

	private beginDrain(): Promise<void> {
		return (this.drainTask ??= Promise.resolve()
			.then(() => this.ctx.runtime.drain())
			.catch((error) => {
				this.drainError = error
			}))
	}

	getDrainError(): unknown {
		return this.drainError
	}

	private async dispatch(event: TransitionEvent, error?: unknown): Promise<void> {
		// Settle errors queued during subscription setup before publishing a stable state.
		await this.transition(event, error)
		this.snapshot = this.buildSnapshot()
		this.notify()
	}

	private async transition(event: TransitionEvent, error?: unknown): Promise<void> {
		const from = this.state
		const next = transitions[from * eventCount + event] as State | -1
		if (next === invalid)
			throw new Error(
				`Invalid Plugin lifecycle transition: ${stateNames[from]} -> ${eventNames[event]}`,
			)
		if (from === State.Running) this.unsubscribeErrors()
		this.state = next
		if (next === State.Running) {
			const onError = (cause: unknown) => {
				void this.dispatch(Event.AsyncError, cause).catch((failure) => this.notifyError(failure))
			}
			try {
				this.errorUnsub = this.ctx.runtime.subscribeErrors?.(onError)
				// A synchronous error can leave running before subscribeErrors returns its cleanup.
				if (this.state !== State.Running) this.unsubscribeErrors()
			} catch (cause) {
				// Subscription installation is part of start admission; startRuntime reports its failure.
				this.state = from
				throw cause
			}
		}
		if (event === Event.Start) await this.startRuntime()
		else if (event === Event.Stop) await this.stopRuntime()
		else if (event === Event.AsyncError) {
			this.ctx.err = toError(error)
			this.ctx.failedStep = 'runtime'
			this.ctx.attempt++
		}
	}

	private notify() {
		const snapshot = this.snapshot
		for (const listener of this.listeners) {
			try {
				listener.next?.(snapshot)
			} catch (error) {
				this.notifyError(error)
			}
		}
	}

	private notifyError(err: unknown) {
		for (const listener of this.listeners) {
			try {
				listener.error?.(err)
			} catch {
				// Reporting is terminal: a broken observer cannot change lifecycle facts or block drain.
			}
		}
	}

	private buildSnapshot(): LifecycleSnapshot {
		const value = stateNames[this.state]
		return {
			value,
			context: this.ctx,
			status: value === 'stopped' ? 'stopped' : undefined,
		}
	}
}

/* ────────────────────────── 便捷 selector ────────────────────────── */
type SnapshotLike = LifecycleSnapshot | undefined

const isState =
	<T extends LifecycleState>(target: T) =>
	(s: SnapshotLike) =>
		!!s && s.value === target

const isRunning = isState('running')
const isStopped = (s: SnapshotLike) => !!s && (s.status === 'stopped' || s.value === 'stopped')
const isStable = (s: SnapshotLike) => !!s && (isRunning(s) || s.value === 'failing' || isStopped(s))

export const lifecycleSelectors = {
	isRunning,
	isStopped,
	isStable,
	lastError: <C extends LifecycleCtx>(s: { context: C }) => s.context.err,
	uptime: <C extends LifecycleCtx>(s: { context: C }) =>
		s.context.startedAt ? Date.now() - s.context.startedAt : undefined,
	failedStep: <C extends LifecycleCtx>(s: { context: C }) => s.context.failedStep,
}
