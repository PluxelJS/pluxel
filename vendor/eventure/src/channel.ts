import {
	ChannelListenerScope,
	type EvtChannelPosition,
	type EvtChannelScope,
} from './channelScope'
import {
	appendListenerCopy,
	copyWithoutIndex,
	createWrapHelper,
	insertListenerCopy,
	ORIGFUNC,
	onSyncError,
	prependListenerCopy,
} from './core/listener'
import {
	attachDispose,
	encodeListenerPosition,
	normalizeMaxListeners,
	noopSubscription,
	POS_BACK,
	POS_FRONT,
	POS_INDEX,
	POS_RESOLVE,
	type PositionKind,
	resolveInsertIndex,
	withAbortSignal,
} from './core/registration'
import {
	emitAllFromListeners,
	emitSettledFromListeners,
} from './ext/emitShared'
import {
	type FireAsyncRecord,
	type FireSyncRecord,
	fireAsyncFromListeners,
	fireFromListeners,
} from './ext/fireShared'
import {
	createLimitedListener,
	type GuardPredicate,
	normalizeTimes,
} from './ext/limitSingle'
import {
	type CancellablePromise,
	type WaitForSingleOptions,
	waitForSingle,
} from './ext/waitForSingle'
import {
	type SplitWaterfall as CoreSplitWaterfall,
	runWaterfall,
	type WFResult,
} from './ext/waterfallShared'
import { defaultLogger, type Logger } from './logger'
import type {
	ErrorPolicy,
	EventArgs,
	EventDescriptor,
	EventureOptions,
	EventListener,
	EventResult,
	EmitSettledRecord,
	SubscriptionOptions,
	Unsubscribe,
} from './types'

export type EvtChannelOptions<D extends EventDescriptor> = Omit<
	EventureOptions<Record<string | symbol, D>>,
	'preallocateEvents'
>

export type EvtChannelFireSyncResult<D extends EventDescriptor> =
	FireSyncRecord<D>
export type EvtChannelFireAsyncResult<D extends EventDescriptor> =
	FireAsyncRecord<D>
export type EvtChannelSplit<D extends EventDescriptor> = CoreSplitWaterfall<D>
export type EvtChannelWFResult<D extends EventDescriptor> =
	EvtChannelSplit<D> extends never
		? WFResult<never>
		: WFResult<EvtChannelSplit<D>['ret']>
export type EvtChannelWaitForOptions<D extends EventDescriptor> =
	WaitForSingleOptions<D>
export type EvtChannelWaitForPromise<D extends EventDescriptor> =
	CancellablePromise<EventArgs<D>>

export type { EvtChannelPosition, EvtChannelScope } from './channelScope'

export class EvtChannel<D extends EventDescriptor = EventDescriptor> {
	protected _listeners: EventListener<D>[] = []

	protected _maxListeners = 10
	get maxListeners(): number {
		return this._maxListeners
	}
	set maxListeners(count: number) {
		this._maxListeners = normalizeMaxListeners(count)
	}

	protected _logger: Logger
	protected _errorPolicy: ErrorPolicy

	protected _wrap: <T extends (...args: any[]) => any>(listener: T) => T

	constructor(options?: EvtChannelOptions<D>) {
		this._logger = options?.logger ?? defaultLogger
		const captureRejections = options?.captureRejections ?? true
		const captureReturnedPromises = options?.captureReturnedPromises ?? false
		this._errorPolicy = options?.errorPolicy ?? 'log'

		this._wrap = createWrapHelper({
			logger: this._logger,
			captureRejections,
			captureReturnedPromises,
			errorPolicy: this._errorPolicy,
		})
	}

	protected _onSyncError(err: unknown): void {
		onSyncError(err, this._errorPolicy, this._logger)
	}

	protected _insert(
		fn: EventListener<D>,
		posKind: PositionKind,
		posValue: number | ((ctx: { count: number }) => number),
		signal?: AbortSignal,
	): Unsubscribe {
		if (posKind === POS_BACK) return this._append(fn, signal)
		if (signal !== undefined && signal.aborted) return noopSubscription

		const prev = this._listeners
		const count = prev.length
		let next: EventListener<D>[]
		switch (posKind) {
			case POS_FRONT:
				next = prependListenerCopy(prev, fn)
				break
			case POS_INDEX:
				next = insertListenerCopy(
					prev,
					resolveInsertIndex(count, posValue as number),
					fn,
				)
				break
			case POS_RESOLVE:
				next = insertListenerCopy(
					prev,
					resolveInsertIndex(
						count,
						posValue as (ctx: { count: number }) => number,
						{ count },
					),
					fn,
				)
				break
		}
		this._listeners = next

		const maxListeners = this._maxListeners
		if (maxListeners !== 0 && next.length > maxListeners) {
			this._logger.warn(
				`MaxListenersExceededWarning(remind memory leak): channel has ${next.length} listeners that exceed ${this._maxListeners}`,
			)
		}

		const sub = this._makeSubscription(fn)

		return signal === undefined ? sub : withAbortSignal(signal, sub)
	}

	protected _append(fn: EventListener<D>, signal?: AbortSignal): Unsubscribe {
		if (signal !== undefined && signal.aborted) return noopSubscription

		const next = appendListenerCopy(this._listeners, fn)
		this._listeners = next

		const maxListeners = this._maxListeners
		if (maxListeners !== 0 && next.length > maxListeners) {
			this._logger.warn(
				`MaxListenersExceededWarning(remind memory leak): channel has ${next.length} listeners that exceed ${this._maxListeners}`,
			)
		}

		const sub = this._makeSubscription(fn)
		return signal === undefined ? sub : withAbortSignal(signal, sub)
	}

	protected _add(
		listener: EventListener<D>,
		times: number,
		posKind: PositionKind,
		posValue: number | ((ctx: { count: number }) => number),
		predicate?: GuardPredicate<D>,
		signal?: AbortSignal,
	): Unsubscribe {
		if (signal !== undefined && signal.aborted) return noopSubscription

		const wrapped = this._wrap(listener)
		if (times === 0 && predicate === undefined) {
			return posKind === POS_BACK
				? this._append(wrapped, signal)
				: this._insert(wrapped, posKind, posValue, signal)
		}

		let offRef: Unsubscribe | null = null
		const unsubscribe = attachDispose((() => {
			const off = offRef
			if (off !== null) {
				offRef = null
				off()
			}
		}) as Unsubscribe)

		const fn = createLimitedListener(wrapped, times, predicate, unsubscribe)
		Object.defineProperty(fn, ORIGFUNC, { value: listener, writable: false })
		offRef = this._insert(fn, posKind, posValue, signal)
		return unsubscribe
	}

	protected _makeSubscription(registered: EventListener<D>): Unsubscribe {
		const unsub: Unsubscribe = (() => {
			this._offRegistered(registered)
		}) as Unsubscribe
		return attachDispose(unsub)
	}

	public on(
		listener: EventListener<D>,
		options?: SubscriptionOptions,
	): Unsubscribe {
		return this._append(this._wrap(listener), options?.signal)
	}

	public off(listener: EventListener<D>): boolean {
		return this._offBy(listener, false)
	}

	protected _offRegistered(listener: EventListener<D>): boolean {
		return this._offBy(listener, true)
	}

	protected _offBy(listener: EventListener<D>, exact: boolean): boolean {
		const prev = this._listeners
		if (prev.length === 0) return false
		let idx = -1
		for (let i = 0; i < prev.length; i++) {
			const fn = prev[i] as any
			if (fn === listener || (!exact && fn[ORIGFUNC] === listener)) {
				idx = i
				break
			}
		}
		if (idx < 0) return false
		if (prev.length === 1) {
			this._listeners = []
		} else {
			this._listeners = copyWithoutIndex(prev, idx)
		}
		return true
	}

	public clear(): void {
		this._listeners = []
	}

	public emit(...args: EventArgs<D>): number {
		const fns = this._listeners
		if (fns.length === 0) return 0
		const len = fns.length
		switch (args.length) {
			case 0:
				for (let i = 0; i < len; i++) {
					try {
						;(fns[i] as any)()
					} catch (err) {
						this._onSyncError(err)
					}
				}
				break
			case 1: {
				const arg0 = args[0]!
				for (let i = 0; i < len; i++) {
					try {
						;(fns[i] as any)(arg0)
					} catch (err) {
						this._onSyncError(err)
					}
				}
				break
			}
			case 2: {
				const arg0 = args[0]!
				const arg1 = args[1]!
				for (let i = 0; i < len; i++) {
					try {
						;(fns[i] as any)(arg0, arg1)
					} catch (err) {
						this._onSyncError(err)
					}
				}
				break
			}
			case 3: {
				const arg0 = args[0]!
				const arg1 = args[1]!
				const arg2 = args[2]!
				for (let i = 0; i < len; i++) {
					try {
						;(fns[i] as any)(arg0, arg1, arg2)
					} catch (err) {
						this._onSyncError(err)
					}
				}
				break
			}
			case 4: {
				const arg0 = args[0]!
				const arg1 = args[1]!
				const arg2 = args[2]!
				const arg3 = args[3]!
				for (let i = 0; i < len; i++) {
					try {
						;(fns[i] as any)(arg0, arg1, arg2, arg3)
					} catch (err) {
						this._onSyncError(err)
					}
				}
				break
			}
			default:
				for (let i = 0; i < len; i++) {
					try {
						;(fns[i] as any)(...args)
					} catch (err) {
						this._onSyncError(err)
					}
				}
		}
		return len
	}

	public emitAll(...args: EventArgs<D>): Promise<Awaited<EventResult<D>>[]> {
		return emitAllFromListeners(this._listeners, args)
	}

	public emitSettled(
		...args: EventArgs<D>
	): Promise<EmitSettledRecord<EventListener<D>, Awaited<EventResult<D>>>[]> {
		return emitSettledFromListeners(this._listeners, args)
	}

	public count(): number {
		return this._listeners.length
	}

	public listeners(): EventListener<D>[] {
		return this._listeners.slice()
	}

	public once(
		listener: EventListener<D>,
		options?: SubscriptionOptions,
	): Unsubscribe {
		return this._add(listener, 1, POS_BACK, 0, undefined, options?.signal)
	}

	public many(
		times: number,
		listener: EventListener<D>,
		options?: SubscriptionOptions,
	): Unsubscribe {
		normalizeTimes(times)
		return this._add(listener, times, POS_BACK, 0, undefined, options?.signal)
	}

	protected _scope(
		posKind: PositionKind,
		posValue: number | ((ctx: { count: number }) => number),
		predicate?: GuardPredicate<D>,
	): EvtChannelScope<D> {
		const add = (
			listener: EventListener<D>,
			times: number,
			scopePosKind: PositionKind,
			scopePosValue: number | ((ctx: { count: number }) => number),
			scopePredicate?: GuardPredicate<D>,
			signal?: AbortSignal,
		) =>
			this._add(
				listener,
				times,
				scopePosKind,
				scopePosValue,
				scopePredicate,
				signal,
			)
		return new ChannelListenerScope(
			add,
			posKind,
			posValue,
			predicate,
		) as EvtChannelScope<D>
	}

	public when(predicate: GuardPredicate<D>): EvtChannelScope<D> {
		return this._scope(POS_BACK, 0, predicate)
	}

	public at(position: EvtChannelPosition): EvtChannelScope<D> {
		const [encodedKind, encodedValue] = encodeListenerPosition(position)
		return this._scope(encodedKind, encodedValue)
	}

	public waitFor(
		options?: EvtChannelWaitForOptions<D>,
	): EvtChannelWaitForPromise<D> {
		const register = (listener: EventListener<D>) => this._append(listener)
		return waitForSingle(this._wrap, register, options, 'channel')
	}

	public fire(...args: EventArgs<D>): Generator<EvtChannelFireSyncResult<D>>
	public fire(...args: EventArgs<D>): Generator<EvtChannelFireSyncResult<D>> {
		return fireFromListeners(this._listeners, args)
	}

	public fireFrom(
		listeners: EventListener<D>[],
		...args: EventArgs<D>
	): Generator<EvtChannelFireSyncResult<D>> {
		return fireFromListeners(listeners, args)
	}

	public fireAsync(
		...args: EventArgs<D>
	): AsyncGenerator<EvtChannelFireAsyncResult<D>>
	public fireAsync(
		...args: EventArgs<D>
	): AsyncGenerator<EvtChannelFireAsyncResult<D>> {
		return fireAsyncFromListeners(this._listeners, args)
	}

	public fireAsyncFrom(
		listeners: EventListener<D>[],
		...args: EventArgs<D>
	): AsyncGenerator<EvtChannelFireAsyncResult<D>>
	public fireAsyncFrom(
		listeners: EventListener<D>[],
		...args: EventArgs<D>
	): AsyncGenerator<EvtChannelFireAsyncResult<D>> {
		return fireAsyncFromListeners(listeners, args)
	}

	public waterfall(
		...args: EvtChannelSplit<D> extends never
			? never[]
			: [...EvtChannelSplit<D>['args'], EvtChannelSplit<D>['next']]
	): EvtChannelWFResult<D>
	public waterfall(
		...args: EvtChannelSplit<D> extends never
			? never[]
			: EvtChannelSplit<D>['args']
	): EvtChannelWFResult<D>
	public waterfall(...args: any[]): EvtChannelWFResult<D> {
		return runWaterfall(this._listeners, args) as any
	}

	public waterfallFrom(
		listeners: EventListener<D>[],
		...args: EvtChannelSplit<D> extends never
			? never[]
			: EvtChannelSplit<D>['args']
	): EvtChannelWFResult<D>
	public waterfallFrom(
		listeners: EventListener<D>[],
		...args: EvtChannelSplit<D> extends never
			? never[]
			: [...EvtChannelSplit<D>['args'], EvtChannelSplit<D>['next']]
	): EvtChannelWFResult<D>
	public waterfallFrom(
		listeners: EventListener<D>[],
		...args: any[]
	): EvtChannelWFResult<D> {
		return runWaterfall(listeners, args) as any
	}
}
