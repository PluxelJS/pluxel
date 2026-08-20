import { type Context as PluxelContext, Injectable } from '@pluxel/context'

export type Cleanup = () => void | Promise<void>
/** A resource handle whose async disposal settles only after its owned work has stopped. */
export type DisposableLike = { dispose: () => void | Promise<void> }
export type Phase = 'shutdown' | 'runtime' | 'final'

export type EffectsMeta = {
	tag?: string
	phase?: Phase
	critical?: boolean
}

export class EffectsDisposedError extends Error {
	name = 'EffectsDisposedError'
	constructor(message = 'Effects service is disposed') {
		super(message)
	}
}

export class EffectsFrozenError extends Error {
	name = 'EffectsFrozenError'
	constructor(message = 'Effects service is frozen (transaction in progress)') {
		super(message)
	}
}

const serviceName = 'effects' as const
declare module '@pluxel/context' {
	namespace Context {
		interface Services {
			[serviceName]: EffectsService
		}
	}
}

const ServiceState = {
	LIVE: 0,
	DISPOSING: 1,
	DISPOSED: 2,
} as const
type ServiceState = (typeof ServiceState)[keyof typeof ServiceState]

const EntryKind = {
	CLEANUP: 0,
	DISPOSABLE: 1,
	RELEASE: 2,
} as const
type EntryKind = (typeof EntryKind)[keyof typeof EntryKind]

const EntryState = {
	ACTIVE: 0,
	RUNNING: 1,
	DONE: 2,
} as const
type EntryState = (typeof EntryState)[keyof typeof EntryState]

const PHASES: readonly Phase[] = ['shutdown', 'runtime', 'final'] as const
const DEFAULT_PHASE: Phase = 'runtime'
const EFFECTS_CHILD_SCOPE = Symbol.for('pluxel:effects:child-scope')

// Stack stores a "handle" = token * HANDLE_STRIDE + id, so id reuse is safe.
const HANDLE_ID_BITS = 20
const HANDLE_STRIDE = 2 ** HANDLE_ID_BITS

function isPromiseLike(x: unknown): x is PromiseLike<unknown> {
	return (
		!!x &&
		(typeof x === 'object' || typeof x === 'function') &&
		typeof (x as any).then === 'function'
	)
}

function normalizePhase(phase: Phase | undefined): Phase {
	return phase ?? DEFAULT_PHASE
}

function phaseIndex(phase: Phase): number {
	// Small fixed set; keep it branchy and fast.
	if (phase === 'shutdown') return 0
	if (phase === 'runtime') return 1
	return 2
}

function decodeHandle(handle: number): { id: number; token: number } {
	const id = handle % HANDLE_STRIDE
	const token = (handle - id) / HANDLE_STRIDE
	return { id, token }
}

export interface EffectGuardHost {
	isActive(id: number, token: number): boolean
	cancel(id: number, token: number): void
	runMaybeAsync(id: number, token: number): void | Promise<void>
	runAsync(id: number, token: number): Promise<void>
}

export class EffectGuard {
	readonly #effects: EffectGuardHost
	readonly #id: number
	readonly #token: number

	constructor(effects: EffectGuardHost, id: number, token: number) {
		this.#effects = effects
		this.#id = id
		this.#token = token
	}

	get active(): boolean {
		return this.#effects.isActive(this.#id, this.#token)
	}

	cancel(): void {
		this.#effects.cancel(this.#id, this.#token)
	}

	dispose(): void | Promise<void> {
		return this.#effects.runMaybeAsync(this.#id, this.#token)
	}

	disposeAsync(): Promise<void> {
		return this.#effects.runAsync(this.#id, this.#token)
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.disposeAsync()
	}

	[Symbol.dispose](): void {
		const ret = this.dispose()
		if (isPromiseLike(ret)) {
			throw new Error('EffectGuard is async; use `await using` or `await guard.dispose()`.')
		}
	}
}

export type AcquireFn<T> = () => T | Promise<T>
export type ReleaseFn<T> = (value: T) => void | Promise<void>

export interface Effects {
	defer(cleanup: Cleanup, meta?: EffectsMeta): EffectGuard
	/** Own a resource until this effects scope disposes or the returned guard releases it early. */
	own(disposable: DisposableLike, meta?: EffectsMeta): EffectGuard
	acquire<T>(acquire: AcquireFn<T>, release: ReleaseFn<T>, meta?: EffectsMeta): Promise<T>
	scope(meta?: EffectsMeta): EffectsScope
	transaction<R>(fn: (tx: Effects) => R | Promise<R>): Promise<R>
	dispose(): Promise<void>
}

export interface EffectsScope extends Effects {
	[Symbol.asyncDispose](): Promise<void>
}

class EffectsTxView implements Effects {
	constructor(private readonly impl: EffectsImpl) {}
	defer(cleanup: Cleanup, meta?: EffectsMeta): EffectGuard {
		return this.impl.defer(cleanup, meta, { allowFrozen: true })
	}
	own(disposable: DisposableLike, meta?: EffectsMeta): EffectGuard {
		return this.impl.own(disposable, meta, { allowFrozen: true })
	}
	acquire<T>(acquire: AcquireFn<T>, release: ReleaseFn<T>, meta?: EffectsMeta): Promise<T> {
		return this.impl.acquire(acquire, release, meta, { allowFrozen: true })
	}
	scope(meta?: EffectsMeta): EffectsScope {
		return this.impl.scope(meta, { allowFrozen: true })
	}
	transaction<R>(fn: (tx: Effects) => R | Promise<R>): Promise<R> {
		return this.impl.transaction(fn)
	}
	dispose(): Promise<void> {
		return this.impl.dispose()
	}
}

type RegisterOpts = { allowFrozen?: boolean }

class EffectsImpl implements Effects, EffectGuardHost {
	private state: ServiceState = ServiceState.LIVE
	private disposePromise: Promise<void> | null = null
	private readonly resolved: Promise<void> = Promise.resolve()

	private freezeDepth = 0
	private drainPhaseIndex: number | null = null

	private readonly stacks: [number[], number[], number[]] = [[], [], []]

	private nextId = 0
	private readonly freeIds: number[] = []
	private readonly tokenById: number[] = []

	private readonly kindById: EntryKind[] = []
	private readonly stateById: EntryState[] = []
	private readonly aById: unknown[] = []
	private readonly bById: unknown[] = []
	private readonly promiseById: (Promise<void> | null)[] = []
	private readonly resolveById: (((value: void) => void) | null)[] = []
	private readonly rejectById: (((reason?: unknown) => void) | null)[] = []
	private readonly metaById: (EffectsMeta | null)[] = []

	constructor(
		private readonly ctx: PluxelContext,
		opts?: { parent?: EffectsImpl; meta?: EffectsMeta; registerOpts?: RegisterOpts },
	) {
		if (opts?.parent) {
			opts.parent.own(this as unknown as DisposableLike, opts.meta, opts.registerOpts)
		}
	}

	isActive(id: number, token: number): boolean {
		return this.tokenById[id] === token && this.stateById[id] === EntryState.ACTIVE
	}

	private assertRegisterAllowed(opts?: RegisterOpts): void {
		if (this.state === ServiceState.DISPOSED) throw new EffectsDisposedError()
		if (!opts?.allowFrozen && this.freezeDepth > 0) throw new EffectsFrozenError()
	}

	private alloc(
		kind: EntryKind,
		a: unknown,
		b: unknown,
		meta: EffectsMeta | undefined,
	): EffectGuard {
		const id = this.freeIds.length > 0 ? (this.freeIds.pop() as number) : this.nextId++
		if (id >= HANDLE_STRIDE) {
			throw new Error(`Effects registry overflow: id=${id} exceeds HANDLE_STRIDE=${HANDLE_STRIDE}.`)
		}
		const nextToken = (this.tokenById[id] ?? 0) + 1
		this.tokenById[id] = nextToken

		this.kindById[id] = kind
		this.stateById[id] = EntryState.ACTIVE
		this.aById[id] = a
		this.bById[id] = b
		this.promiseById[id] = null
		this.metaById[id] = meta ?? null

		const handle = nextToken * HANDLE_STRIDE + id
		const reqPhase = normalizePhase(meta?.phase)
		let pIdx = phaseIndex(reqPhase)
		const drainIdx = this.drainPhaseIndex
		if (drainIdx !== null && drainIdx !== undefined && pIdx < drainIdx) pIdx = drainIdx
		this.stacks[pIdx].push(handle)

		return new EffectGuard(this, id, nextToken)
	}

	defer(cleanup: Cleanup, meta?: EffectsMeta, opts?: RegisterOpts): EffectGuard {
		this.assertRegisterAllowed(opts)
		return this.alloc(EntryKind.CLEANUP, cleanup, null, meta)
	}

	own(disposable: DisposableLike, meta?: EffectsMeta, opts?: RegisterOpts): EffectGuard {
		this.assertRegisterAllowed(opts)
		return this.alloc(EntryKind.DISPOSABLE, disposable, null, meta)
	}

	async acquire<T>(
		acquire: AcquireFn<T>,
		release: ReleaseFn<T>,
		meta?: EffectsMeta,
		opts?: RegisterOpts,
	): Promise<T> {
		const value = await acquire()
		try {
			this.assertRegisterAllowed(opts)
			this.alloc(EntryKind.RELEASE, value, release, meta)
		} catch (error) {
			try {
				await release(value)
			} catch (releaseError) {
				this.ctx.logger.error('effects acquire release error', {
					error: releaseError,
					tag: meta?.tag,
				})
			}
			throw error
		}
		return value
	}

	scope(meta?: EffectsMeta, opts?: RegisterOpts, ownerCtx: PluxelContext = this.ctx): EffectsScope {
		this.assertRegisterAllowed(opts)
		// Child scopes are owned by default so parent disposal propagates.
		return new EffectsScopeImpl(ownerCtx, { parent: this, meta, registerOpts: opts })
	}

	async transaction<R>(fn: (tx: Effects) => R | Promise<R>): Promise<R> {
		if (this.state !== ServiceState.LIVE) throw new EffectsDisposedError()
		const checkpoints = [
			this.stacks[0].length,
			this.stacks[1].length,
			this.stacks[2].length,
		] as const
		this.freezeDepth++
		const tx = new EffectsTxView(this)
		try {
			return await fn(tx)
		} catch (error) {
			try {
				await this.rollback(checkpoints)
			} catch (rollbackError) {
				const aggregate = new AggregateError(
					[error, rollbackError],
					'Effects transaction failed (rollback errors)',
					{ cause: rollbackError },
				)
				throw aggregate
			}
			throw error
		} finally {
			this.freezeDepth--
		}
	}

	private async rollback(checkpoints: readonly [number, number, number]): Promise<void> {
		const errors: unknown[] = []
		for (let pIdx = 0; pIdx < PHASES.length; pIdx++) {
			this.drainPhaseIndex = pIdx
			const stack = this.stacks[pIdx]
			const checkpoint = checkpoints[pIdx]
			while (stack.length > checkpoint) {
				const handle = stack.pop() as number
				try {
					const { id, token } = decodeHandle(handle)
					await this.runAsync(id, token)
				} catch (e) {
					errors.push(e)
				}
			}
		}
		this.drainPhaseIndex = null
		if (errors.length > 0) {
			throw new AggregateError(errors, 'Effects transaction rollback errors')
		}
	}

	cancel(id: number, token: number): void {
		if (this.tokenById[id] !== token) return
		const st = this.stateById[id]
		if (st === EntryState.DONE || st === EntryState.RUNNING) return
		this.finish(id)
	}

	runMaybeAsync(id: number, token: number): void | Promise<void> {
		if (this.tokenById[id] !== token) return
		const st = this.stateById[id]
		if (st === EntryState.DONE) return
		if (st === EntryState.RUNNING) {
			const existing = this.promiseById[id]
			if (existing) return existing
			let resolve!: (value: void) => void
			let reject!: (reason?: unknown) => void
			const p = new Promise<void>((res, rej) => {
				resolve = res
				reject = rej
			})
			this.promiseById[id] = p
			this.resolveById[id] = resolve
			this.rejectById[id] = reject
			return p
		}

		this.stateById[id] = EntryState.RUNNING
		let ret: unknown
		try {
			const kind = this.kindById[id]
			if (kind === EntryKind.CLEANUP) {
				ret = (this.aById[id] as Cleanup)()
			} else if (kind === EntryKind.DISPOSABLE) {
				ret = (this.aById[id] as DisposableLike).dispose()
			} else {
				ret = (this.bById[id] as (v: unknown) => unknown)(this.aById[id])
			}
		} catch (error) {
			const reject = this.rejectById[id]
			if (reject) {
				this.resolveById[id] = null
				this.rejectById[id] = null
				reject(error)
			}
			this.finish(id)
			throw error
		}

		if (!isPromiseLike(ret)) {
			const resolve = this.resolveById[id]
			if (resolve) {
				this.resolveById[id] = null
				this.rejectById[id] = null
				resolve()
			}
			this.finish(id)
			return
		}

		let p = this.promiseById[id]
		if (!p) {
			let resolve!: (value: void) => void
			let reject!: (reason?: unknown) => void
			p = new Promise<void>((res, rej) => {
				resolve = res
				reject = rej
			})
			this.promiseById[id] = p
			this.resolveById[id] = resolve
			this.rejectById[id] = reject
		}

		void (async () => {
			try {
				await Promise.resolve(ret)
				const resolve = this.resolveById[id]
				if (resolve) {
					this.resolveById[id] = null
					this.rejectById[id] = null
					resolve()
				}
			} catch (error) {
				const reject = this.rejectById[id]
				if (reject) {
					this.resolveById[id] = null
					this.rejectById[id] = null
					reject(error)
				}
			} finally {
				this.finish(id)
			}
		})()

		return p
	}

	runAsync(id: number, token: number): Promise<void> {
		try {
			const ret = this.runMaybeAsync(id, token)
			return isPromiseLike(ret) ? (ret as Promise<void>) : this.resolved
		} catch (e) {
			return Promise.reject(e)
		}
	}

	private finish(id: number): void {
		this.stateById[id] = EntryState.DONE
		this.kindById[id] = EntryKind.CLEANUP
		this.aById[id] = null
		this.bById[id] = null
		this.promiseById[id] = null
		this.resolveById[id] = null
		this.rejectById[id] = null
		this.metaById[id] = null
		this.freeIds.push(id)
	}

	dispose(): Promise<void> {
		if (this.disposePromise) return this.disposePromise
		if (this.state === ServiceState.DISPOSED) return this.resolved

		this.state = ServiceState.DISPOSING
		this.disposePromise = (async () => {
			const errors: unknown[] = []
			try {
				for (let pIdx = 0; pIdx < PHASES.length; pIdx++) {
					this.drainPhaseIndex = pIdx
					const stack = this.stacks[pIdx]
					while (stack.length > 0) {
						const handle = stack.pop() as number
						const { id, token } = decodeHandle(handle)
						const meta = this.tokenById[id] === token ? this.metaById[id] : null
						try {
							await this.runAsync(id, token)
						} catch (error) {
							errors.push(error)
							this.ctx.logger.error('effects dispose error', {
								error,
								tag: meta?.tag,
								phase: PHASES[pIdx],
								critical: meta?.critical,
							})
						}
					}
				}
			} finally {
				this.drainPhaseIndex = null
				this.state = ServiceState.DISPOSED
			}
			if (errors.length > 0) throw new AggregateError(errors, 'Effects dispose errors')
		})()

		return this.disposePromise
	}
}

class EffectsScopeImpl implements EffectsScope {
	protected readonly impl: EffectsImpl
	constructor(
		public readonly ctx: PluxelContext,
		opts?: { parent?: EffectsImpl; meta?: EffectsMeta; registerOpts?: RegisterOpts },
	) {
		this.impl = new EffectsImpl(ctx, opts)
	}

	defer(cleanup: Cleanup, meta?: EffectsMeta): EffectGuard {
		return this.impl.defer(cleanup, meta)
	}
	own(disposable: DisposableLike, meta?: EffectsMeta): EffectGuard {
		return this.impl.own(disposable, meta)
	}
	acquire<T>(acquire: AcquireFn<T>, release: ReleaseFn<T>, meta?: EffectsMeta): Promise<T> {
		return this.impl.acquire(acquire, release, meta)
	}
	scope(meta?: EffectsMeta): EffectsScope {
		return this.impl.scope(meta)
	}

	/** @internal Create a child scope whose diagnostics and nested registrations retain owner ctx. */
	[EFFECTS_CHILD_SCOPE](ctx: PluxelContext, meta?: EffectsMeta): EffectsScope {
		return this.impl.scope(meta, undefined, ctx)
	}
	transaction<R>(fn: (tx: Effects) => R | Promise<R>): Promise<R> {
		return this.impl.transaction(fn)
	}
	dispose(): Promise<void> {
		return this.impl.dispose()
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.dispose()
	}
}

@Injectable({ key: serviceName })
export class EffectsService extends EffectsScopeImpl {
	constructor(ctx: PluxelContext, _cfg: unknown) {
		super(ctx)
	}
}
