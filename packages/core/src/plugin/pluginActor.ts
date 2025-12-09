import { bakeMachine } from '../../fsm/defineMachine.macro' with { type: 'macro' }
import { hydrateMachine, type MachineImpl } from '../../fsm/defineMachine.macro'
import type { PluginLifecycleRuntime } from './BasePlugin'

/* ────────────────────────── 外部事件 ────────────────────────── */
export type LifecycleEvent =
	| { type: 'START' }
	| { type: 'STOP' }
	| { type: 'RETRY' }
	| { type: 'ASYNC_ERROR'; error: unknown }

/* ────────────────────────── 机器输入 & 上下文 ────────────────────────── */

export interface LifecycleInput {
	id: unknown
	runtime: PluginLifecycleRuntime
}

type FailedStep = 'start' | 'stop' | 'runtime' | undefined

interface LifecycleCtx extends LifecycleInput {
	attempt: number // 连续失败次数（成功后清零）
	err?: Error // 最近一次错误（保真 Error）
	startedAt?: number // 首次成功启动时间戳
	failedStep: FailedStep // 失败发生在哪个阶段
}

/* ────────────────────────── 选项 ────────────────────────── */
export interface LifecycleOptions {
	/** actor.start() 时是否自动发 START */
	autoStart?: boolean
	/** 运行态是否订阅插件侧的错误上报（用于延迟抛错） */
	useErrorChannel?: boolean
}

export interface LifecycleSnapshot {
	value: LifecycleState
	context: LifecycleCtx
	status?: 'stopped'
}

type Observer<T> = { next?: (value: T) => void; error?: (err: unknown) => void }

const errNoTran = (from: LifecycleState, event: string) =>
	`No transition: from ${from} event ${event}`

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

const stateNames = ['idle', 'starting', 'running', 'stopping', 'failing', 'stopped'] as const
type LifecycleState = (typeof stateNames)[number]

const bakedLifecycle = bakeMachine({
	states: ['idle', 'starting', 'running', 'stopping', 'failing', 'stopped'] as const,
	events: [
		'start',
		'startOk',
		'startErr',
		'stop',
		'stopOk',
		'stopErr',
		'asyncError',
		'retry',
	] as const,
	init: 'idle',
	transitions: [
		['idle', 'start', 'starting', 'onStart'],
		['idle', 'stop', 'stopped', 'onStop'],
		['starting', 'startOk', 'running'],
		['starting', 'startErr', 'failing'],
		['starting', 'stop', 'stopping', 'onStop'],
		['running', 'stop', 'stopping', 'onStop'],
		['running', 'asyncError', 'failing', 'onAsyncError'],
		['failing', 'stop', 'stopping', 'onStop'],
		['failing', 'retry', 'starting'],
		['stopping', 'stopOk', 'stopped'],
		['stopping', 'stopErr', 'stopped'],
		['stopped', 'start', 'starting', 'onStart'],
	] as const,
	hooks: {
		enter: { running: 'onEnterRunning' },
		exit: { running: 'onExitRunning' },
	} as const,
	abortOnStateChange: false,
})

type LifecycleImpl = MachineImpl<typeof bakedLifecycle>

class PluginLifecycleActor {
	private readonly ctx: LifecycleCtx
	private readonly opts: LifecycleOptions
	private readonly listeners = new Set<Observer<LifecycleSnapshot>>()
	private snapshot: LifecycleSnapshot
	private queue = Promise.resolve()
	private errorUnsub: (() => void) | undefined
	private startAbort: AbortController | null = null
	private stopAbort: AbortController | null = null
	private pendingStop = false
	private readonly machine
	private readonly E
	private readonly S
	private readonly stateNames = stateNames

	constructor(opts: LifecycleOptions, input: LifecycleInput) {
		this.opts = opts
		this.ctx = {
			...input,
			attempt: 0,
			err: undefined,
			startedAt: undefined,
			failedStep: undefined,
		}

		const dispatch = (ev: number, ...args: any[]) => this.dispatch(ev, ...args)

		const impl: LifecycleImpl = {
			callbacks: {
				onStart: async () => {
					this.pendingStop = false
					this.startAbort = new AbortController()
					const { runtime } = this.ctx
					try {
						runtime.beforeStart?.()
						if (runtime.init) await runtime.init(this.startAbort.signal)
						if (this.startAbort.signal.aborted || this.pendingStop) return
						if (!this.ctx.startedAt) this.ctx.startedAt = Date.now()
						this.ctx.err = undefined
						this.ctx.attempt = 0
						this.ctx.failedStep = undefined
						if (this.machine.getState() === this.S.starting) {
							await dispatch(E.startOk)
						}
					} catch (e) {
						if (this.startAbort.signal.aborted && this.pendingStop) return
						this.ctx.err = toError(e)
						this.ctx.failedStep = 'start'
						this.ctx.attempt++
						if (this.machine.getState() === this.S.starting) {
							await dispatch(E.startErr)
						}
					} finally {
						this.startAbort = null
					}
				},
				onStop: async () => {
					this.pendingStop = true
					if (this.startAbort) this.startAbort.abort()
					this.stopAbort = new AbortController()
					const { runtime } = this.ctx
					let stopErr: unknown
					try {
						if (runtime.stop) await runtime.stop(this.stopAbort.signal)
					} catch (e) {
						stopErr = e
					}
					try {
						await runtime.dispose?.()
					} catch {
						/* ignore */
					}
					if (stopErr) {
						if (!this.ctx.err) this.ctx.err = toError(stopErr)
						if (!this.ctx.failedStep) this.ctx.failedStep = 'stop'
						this.ctx.attempt++
						await dispatch(E.stopErr)
					} else {
						await dispatch(E.stopOk)
					}
					this.stopAbort = null
					this.pendingStop = false
				},
				onAsyncError: async (err: unknown) => {
					this.ctx.err = toError(err)
					this.ctx.failedStep = 'runtime'
					this.ctx.attempt++
				},
			},
			hooks: {
				onEnterRunning: () => {
					if (this.opts.useErrorChannel && this.errorUnsub == null) {
						const unsub = this.ctx.runtime.subscribeErrors?.((err) => {
							void dispatch(E.asyncError, err)
						})
						if (typeof unsub === 'function') this.errorUnsub = unsub
					}
				},
				onExitRunning: () => {
					if (this.errorUnsub) {
						try {
							this.errorUnsub()
						} catch {
							/* ignore */
						}
						this.errorUnsub = undefined
					}
				},
			},
		}

		// hydrate machine with instance-specific impl
		const { E, S, createMachine } = hydrateMachine<
			(typeof stateNames)[number],
			keyof typeof bakedLifecycle.E,
			(typeof bakedLifecycle.def.callbackNames)[number],
			(typeof bakedLifecycle.def.hookNames)[number]
		>(bakedLifecycle, impl)
		this.E = E
		this.S = S
		this.machine = createMachine()
		this.snapshot = this.buildSnapshot()
	}

	start() {
		if (this.opts.autoStart) this.send({ type: 'START' })
	}

	stop() {
		this.send({ type: 'STOP' })
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
			let timer: any

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

			if (timeoutMs != null) {
				timer = setTimeout(() => {
					if (done) return
					done = true
					cleanup()
					reject(new Error(`Timed out after ${timeoutMs}ms`))
				}, timeoutMs)
			}
		})
	}

	send(event: LifecycleEvent): void {
		const ev = this.toEvent(event.type)
		const args = event.type === 'ASYNC_ERROR' ? [event.error] : []
		const current = this.snapshot.value
		if (event.type === 'STOP') {
			if (current === 'stopped' || current === 'stopping') return
			this.pendingStop = true
		}
		if (event.type === 'START' && (current === 'running' || current === 'starting')) return
		this.queue = this.queue.then(() => this.dispatch(ev, ...args)).catch((err) => {
			this.notifyError(err)
		})
	}

	private toEvent(type: LifecycleEvent['type']): number {
		switch (type) {
			case 'START':
				return this.E.start
			case 'STOP':
				return this.E.stop
			case 'RETRY':
				return this.E.retry
			case 'ASYNC_ERROR':
				return this.E.asyncError
			default:
				throw new Error(`Unknown event ${type}`)
		}
	}

	private async dispatch(ev: number, ...args: any[]): Promise<void> {
		await this.machine.dispatch(ev, ...args)
		this.snapshot = this.buildSnapshot()
		this.notify()
	}

	private notify() {
		for (const l of this.listeners) l.next?.(this.snapshot)
	}

	private notifyError(err: unknown) {
		for (const l of this.listeners) l.error?.(err)
	}

	private buildSnapshot(): LifecycleSnapshot {
		const id = this.machine.getState()
		const value = this.stateNames[id] as LifecycleState
		return {
			value,
			context: this.ctx,
			status: value === 'stopped' ? 'stopped' : undefined,
		}
	}
}

export type PluginLifecycleRef = PluginLifecycleActor

export function createPluginLifecycle(opts: LifecycleOptions = {}) {
	return (input: LifecycleInput): PluginLifecycleRef => new PluginLifecycleActor(opts, input)
}

/* ────────────────────────── 便捷 selector ────────────────────────── */
export const lifecycleSelectors = {
	isRunning: (s: { value: unknown }) => (s as any).value === 'running',
	lastError: <C extends LifecycleCtx>(s: { context: C }) => s.context.err,
	uptime: <C extends LifecycleCtx>(s: { context: C }) =>
		s.context.startedAt ? Date.now() - s.context.startedAt : undefined,
	failedStep: <C extends LifecycleCtx>(s: { context: C }) => s.context.failedStep,
}
