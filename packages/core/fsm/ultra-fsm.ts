// file: src/ultra-fsm.ts
export type AnyFn = (...args: any[]) => any

export type HookFn = (
	info: Readonly<{
		state: number
		from: number
		to: number
		event: number
		signal?: AbortSignal
	}>,
) => void | Promise<void>

export type ILogger = Partial<typeof console> & {
	error(...data: unknown[]): void
}

export interface UltraDef {
	readonly init: number
	readonly stateCount: number
	readonly eventCount: number

	// size = stateCount * eventCount
	readonly next: Int32Array // to-state or -1
	readonly cbId: Int32Array // callback pool index or -1

	// size = stateCount
	readonly enterId: Int32Array // hook pool index or -1
	readonly exitId: Int32Array // hook pool index or -1
	readonly hasOutgoing: Uint8Array // 1/0

	// dense pools (no holes)
	readonly callbacks: readonly AnyFn[]
	readonly hooks: readonly HookFn[]

	readonly abortOnStateChange: boolean
}

const errNoTran = (from: number, event: number) => `No transition: from ${from} event ${event}`

const isPromiseLike = (v: unknown): v is PromiseLike<unknown> =>
	typeof v === 'object' && v !== null && typeof (v as any).then === 'function'

type HookCtx = {
	state: number
	from: number
	to: number
	event: number
	signal?: AbortSignal
}

const setHookCtx = (
	ctx: HookCtx,
	state: number,
	from: number,
	to: number,
	event: number,
	signal?: AbortSignal,
) => {
	ctx.state = state
	ctx.from = from
	ctx.to = to
	ctx.event = event
	ctx.signal = signal
	return ctx
}

export class UltraMachine {
	private _s: number
	private _abort: AbortController | null
	private readonly logger: ILogger

	// cache fields for JIT-friendliness (avoid nested property lookups)
	private readonly next: Int32Array
	private readonly cbId: Int32Array
	private readonly enterId: Int32Array
	private readonly exitId: Int32Array
	private readonly hasOutgoing: Uint8Array
	private readonly callbacks: readonly AnyFn[]
	private readonly hooks: readonly HookFn[]
	private readonly eventCount: number
	private readonly abortOnStateChange: boolean
	private readonly hookCtx: HookCtx = {
		state: 0,
		from: 0,
		to: 0,
		event: 0,
		signal: undefined,
	}

	constructor(def: UltraDef, logger: ILogger = console) {
		this.logger = logger
		this._s = def.init | 0
		this._abort = def.abortOnStateChange ? new AbortController() : null

		this.next = def.next
		this.cbId = def.cbId
		this.enterId = def.enterId
		this.exitId = def.exitId
		this.hasOutgoing = def.hasOutgoing
		this.callbacks = def.callbacks
		this.hooks = def.hooks
		this.eventCount = def.eventCount | 0
		this.abortOnStateChange = def.abortOnStateChange
	}

	getState(): number {
		return this._s
	}
	getSignal(): AbortSignal | undefined {
		return this._abort?.signal
	}

	can(event: number): boolean {
		if (event < 0 || event >= this.eventCount) return false
		const idx = this._s * this.eventCount + event
		return this.next[idx] !== -1
	}

	isFinal(): boolean {
		return this.hasOutgoing[this._s] === 0
	}

	async dispatch(event: number, ...args: any[]): Promise<void> {
		if (event < 0 || event >= this.eventCount) {
			const msg = errNoTran(this._s, event)
			this.logger.error(msg)
			throw new Error(msg)
		}

		const from = this._s
		const idx = from * this.eventCount + event

		const to = this.next[idx]
		if (to === -1) {
			const msg = errNoTran(from, event)
			this.logger.error(msg)
			throw new Error(msg)
		}

		const prevAbort = this._abort
		const nextAbort = this.abortOnStateChange ? new AbortController() : null

		let step = 'exit hook'
		try {
			const exitHId = this.exitId[from]
			if (exitHId !== -1) {
				const res = this.hooks[exitHId](setHookCtx(this.hookCtx, from, from, to, event, undefined))
				if (isPromiseLike(res)) await res
			}

			step = 'state commit'
			this._s = to
			if (nextAbort) this._abort = nextAbort

			const enterHId = this.enterId[to]
			if (enterHId !== -1) {
				step = 'onEnter hook'
				const res = this.hooks[enterHId](
					setHookCtx(this.hookCtx, to, from, to, event, nextAbort?.signal),
				)
				if (isPromiseLike(res)) await res
			}

			const cbIdx = this.cbId[idx]
			if (cbIdx !== -1) {
				step = 'transition callback'
				const res = this.callbacks[cbIdx](...args)
				if (isPromiseLike(res)) await res
			}

			// Abort previous state only after the transition finishes so rollbacks keep the old signal intact.
			if (this.abortOnStateChange && prevAbort && prevAbort !== nextAbort) {
				prevAbort.abort()
			}
		} catch (e) {
			this._s = from
			if (nextAbort) nextAbort.abort()
			if (this.abortOnStateChange) this._abort = prevAbort
			this.logger.error(`Exception in ${step}`, e)
			throw e
		}
	}

	dispatchAsync(event: number, ...args: any[]): Promise<void> {
		return Promise.resolve().then(() => this.dispatch(event, ...args))
	}
}

export class UltraMachineSync {
	private _s: number
	private _abort: AbortController | null
	private readonly logger: ILogger

	// cache fields for JIT-friendliness
	private readonly next: Int32Array
	private readonly cbId: Int32Array
	private readonly enterId: Int32Array
	private readonly exitId: Int32Array
	private readonly hasOutgoing: Uint8Array
	private readonly callbacks: readonly AnyFn[]
	private readonly hooks: readonly HookFn[]
	private readonly eventCount: number
	private readonly abortOnStateChange: boolean
	private readonly hookCtx: HookCtx = {
		state: 0,
		from: 0,
		to: 0,
		event: 0,
		signal: undefined,
	}

	constructor(def: UltraDef, logger: ILogger = console) {
		this.logger = logger
		this._s = def.init | 0
		this._abort = def.abortOnStateChange ? new AbortController() : null

		this.next = def.next
		this.cbId = def.cbId
		this.enterId = def.enterId
		this.exitId = def.exitId
		this.hasOutgoing = def.hasOutgoing
		this.callbacks = def.callbacks
		this.hooks = def.hooks
		this.eventCount = def.eventCount | 0
		this.abortOnStateChange = def.abortOnStateChange
	}

	getState(): number {
		return this._s
	}
	getSignal(): AbortSignal | undefined {
		return this._abort?.signal
	}

	can(event: number): boolean {
		if (event < 0 || event >= this.eventCount) return false
		const idx = this._s * this.eventCount + event
		return this.next[idx] !== -1
	}

	isFinal(): boolean {
		return this.hasOutgoing[this._s] === 0
	}

	syncDispatch(event: number, ...args: any[]): boolean {
		if (event < 0 || event >= this.eventCount) {
			this.logger.error(errNoTran(this._s, event))
			return false
		}

		const from = this._s
		const idx = from * this.eventCount + event

		const to = this.next[idx]
		if (to === -1) {
			this.logger.error(errNoTran(from, event))
			return false
		}

		const prevAbort = this._abort
		const nextAbort = this.abortOnStateChange ? new AbortController() : null

		let step = 'exit hook'
		try {
			const exitHId = this.exitId[from]
			if (exitHId !== -1) {
				const res = this.hooks[exitHId](setHookCtx(this.hookCtx, from, from, to, event, undefined))
				if (isPromiseLike(res)) {
					throw new Error('sync onExit hook returned a Promise; use dispatch() instead')
				}
			}

			step = 'state commit'
			this._s = to
			if (nextAbort) this._abort = nextAbort

			const enterHId = this.enterId[to]
			if (enterHId !== -1) {
				step = 'onEnter hook'
				const res = this.hooks[enterHId](
					setHookCtx(this.hookCtx, to, from, to, event, nextAbort?.signal),
				)
				if (isPromiseLike(res)) {
					throw new Error('sync onEnter hook returned a Promise; use dispatch() instead')
				}
			}

			const cbIdx = this.cbId[idx]
			if (cbIdx !== -1) {
				step = 'transition callback'
				const res = this.callbacks[cbIdx](...args)
				if (isPromiseLike(res)) {
					throw new Error('sync transition callback returned a Promise; use dispatch() instead')
				}
			}

			// Abort previous state only after the transition finishes so rollbacks keep the old signal intact.
			if (this.abortOnStateChange && prevAbort && prevAbort !== nextAbort) {
				prevAbort.abort()
			}

			return true
		} catch (e) {
			this._s = from
			if (nextAbort) nextAbort.abort()
			if (this.abortOnStateChange) this._abort = prevAbort
			this.logger.error(`Exception in ${step}`, e)
			throw e
		}
	}
}
