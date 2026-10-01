// eventified.ts

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
	EventureListenerScope,
	type EventurePosition,
	type EventureScope,
} from './eventureScope'
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
	runWaterfall,
	type SplitWaterfall,
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
	IEventMap,
	SubscriptionOptions,
	Unsubscribe,
} from './types'

export type EventureFireSyncResult<
	E extends IEventMap<E>,
	K extends keyof E,
> = FireSyncRecord<E[K]>
export type EventureFireAsyncResult<
	E extends IEventMap<E>,
	K extends keyof E,
> = FireAsyncRecord<E[K]>

export type EventureWaitForOptions<
	E extends IEventMap<E>,
	K extends keyof E,
> = WaitForSingleOptions<E[K]>
export type EventureWaitForPromise<
	E extends IEventMap<E>,
	K extends keyof E,
> = CancellablePromise<EventArgs<E[K]>>

export type WFKeys<E extends IEventMap<E>> = {
	[K in keyof E]: SplitWaterfall<E[K]> extends never ? never : K
}[keyof E]

export type EventureSplit<
	E extends IEventMap<E>,
	K extends WFKeys<E>,
> = SplitWaterfall<E[K]>
export type EventureWFResult<E extends IEventMap<E>, K extends WFKeys<E>> =
	EventureSplit<E, K> extends never
		? WFResult<never>
		: WFResult<EventureSplit<E, K>['ret']>

export type { EventurePosition, EventureScope } from './eventureScope'

const EMPTY_LISTENERS: readonly EventListener<any>[] = []

export class Eventure<
	E extends IEventMap<E> = Record<string | symbol, EventDescriptor>,
> {
	// 事件 → 监听器列表（不可变写入，emit 避免 slice）
	protected _listeners: { [K in keyof E]?: EventListener<E[K]>[] } =
		Object.create(null)
	protected _activeEvents = new Set<keyof E>()

	protected _maxListeners = 10
	get maxListeners() {
		return this._maxListeners
	}
	set maxListeners(count: number) {
		this._maxListeners = normalizeMaxListeners(count)
	}

	protected _logger: Logger
	protected _errorPolicy: ErrorPolicy
	/** 预构建包装器，热路径零分配 */
	protected _wrap: <T extends (...args: any[]) => any>(listener: T) => T

	constructor(options?: EventureOptions<E>) {
		this._logger = options?.logger ?? defaultLogger

		if (options?.preallocateEvents) {
			for (const ev of options.preallocateEvents) this._listeners[ev] = []
		}

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

	protected _readListeners<K extends keyof E>(event: K): EventListener<E[K]>[] {
		return (this._listeners[event] ?? EMPTY_LISTENERS) as EventListener<E[K]>[]
	}

	protected _makeSubscription<K extends keyof E>(
		event: K,
		registered: EventListener<E[K]>,
	): Unsubscribe {
		const unsub: Unsubscribe = (() => {
			this._offRegistered(event, registered)
		}) as Unsubscribe
		return attachDispose(unsub)
	}

	protected _insert<K extends keyof E>(
		event: K,
		fn: EventListener<E[K]>,
		posKind: PositionKind,
		posValue: number | ((ctx: { count: number; event: K }) => number),
		signal?: AbortSignal,
	): Unsubscribe {
		if (posKind === POS_BACK) return this._append(event, fn, signal)
		if (signal !== undefined && signal.aborted) return noopSubscription

		const prev = this._listeners[event]
		const count = prev?.length ?? 0
		let next: EventListener<E[K]>[]
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
						posValue as (ctx: { count: number; event: K }) => number,
						{ count, event },
					),
					fn,
				)
				break
		}
		this._listeners[event] = next

		if (count === 0) this._activeEvents.add(event)
		const maxListeners = this._maxListeners
		if (maxListeners !== 0 && next.length > maxListeners) {
			this._logger.warn(
				`MaxListenersExceededWarning(remind memory leak): '${String(event)}' has ${next.length} listeners that exceed ${this._maxListeners}`,
			)
		}

		const sub = this._makeSubscription(event, fn)
		return signal === undefined ? sub : withAbortSignal(signal, sub)
	}

	protected _append<K extends keyof E>(
		event: K,
		fn: EventListener<E[K]>,
		signal?: AbortSignal,
	): Unsubscribe {
		if (signal !== undefined && signal.aborted) return noopSubscription

		const prev = this._listeners[event]
		const next = appendListenerCopy(prev, fn)
		this._listeners[event] = next
		if (prev === undefined || prev.length === 0) this._activeEvents.add(event)

		const maxListeners = this._maxListeners
		if (maxListeners !== 0 && next.length > maxListeners) {
			this._logger.warn(
				`MaxListenersExceededWarning(remind memory leak): '${String(event)}' has ${next.length} listeners that exceed ${this._maxListeners}`,
			)
		}

		const sub = this._makeSubscription(event, fn)
		return signal === undefined ? sub : withAbortSignal(signal, sub)
	}

	protected _add<K extends keyof E>(
		event: K,
		listener: EventListener<E[K]>,
		times: number,
		posKind: PositionKind,
		posValue: number | ((ctx: { count: number; event: K }) => number),
		predicate?: GuardPredicate<E[K]>,
		signal?: AbortSignal,
	): Unsubscribe {
		if (signal !== undefined && signal.aborted) return noopSubscription

		const wrapped = this._wrap(listener)
		if (times === 0 && predicate === undefined) {
			return posKind === POS_BACK
				? this._append(event, wrapped, signal)
				: this._insert(event, wrapped, posKind, posValue, signal)
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
		offRef = this._insert(event, fn, posKind, posValue, signal)
		return unsubscribe
	}

	public on<K extends keyof E>(
		event: K,
		listener: EventListener<E[K]>,
		options?: SubscriptionOptions,
	): Unsubscribe {
		return this._append(event, this._wrap(listener), options?.signal)
	}

	/** 移除单个监听器；返回是否真的移除了一个条目 */
	public off<K extends keyof E>(
		event: K,
		listener: EventListener<E[K]>,
	): boolean {
		return this._offBy(event, listener, false)
	}

	protected _offRegistered<K extends keyof E>(
		event: K,
		listener: EventListener<E[K]>,
	): boolean {
		return this._offBy(event, listener, true)
	}

	protected _offBy<K extends keyof E>(
		event: K,
		listener: EventListener<E[K]>,
		exact: boolean,
	): boolean {
		const prev = this._listeners[event]
		if (!prev || prev.length === 0) return false

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
			this._listeners[event] = undefined
			this._activeEvents.delete(event)
		} else {
			this._listeners[event] = copyWithoutIndex(prev, idx)
		}
		return true
	}

	/** 批量清空；缺省则清空全部 */
	public clear(event?: keyof E): void {
		if (event === undefined) {
			this._listeners = Object.create(null)
			this._activeEvents.clear()
			return
		}
		this._listeners[event] = undefined
		this._activeEvents.delete(event)
	}

	/** —— emit ——（读取不可变快照，热路径零分配 & 无 slice） */
	public emit<K extends keyof E>(event: K, ...args: EventArgs<E[K]>): number {
		const fns = this._listeners[event]
		if (!fns || fns.length === 0) return 0

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

	public emitAll<K extends keyof E>(
		event: K,
		...args: EventArgs<E[K]>
	): Promise<Awaited<EventResult<E[K]>>[]> {
		return emitAllFromListeners(this._listeners[event], args)
	}

	public emitSettled<K extends keyof E>(
		event: K,
		...args: EventArgs<E[K]>
	): Promise<
		EmitSettledRecord<EventListener<E[K]>, Awaited<EventResult<E[K]>>>[]
	> {
		return emitSettledFromListeners(this._listeners[event], args)
	}

	/** 观测/诊断工具：保持只读快照 */
	public count(event: keyof E): number {
		return this._listeners[event]?.length ?? 0
	}
	public events(): (keyof E)[] {
		return Array.from(this._activeEvents)
	}
	public listeners<K extends keyof E>(event: K): EventListener<E[K]>[] {
		return this._listeners[event]?.slice() ?? []
	}
	/**
	 * 直接暴露内部监听器数组（零拷贝）。
	 * 仅用于高级/性能场景；对返回数组做任何 mutate 都可能破坏库的快照语义。
	 */
	public listenersUnsafe<K extends keyof E>(event: K): EventListener<E[K]>[] {
		return this._listeners[event] ?? []
	}
	public queryListeners<K extends keyof E>(event: K): EventListener<E[K]>[] {
		return this.listenersUnsafe(event)
	}

	public once<K extends keyof E>(
		event: K,
		listener: EventListener<E[K]>,
		options?: SubscriptionOptions,
	): Unsubscribe {
		return this._add(
			event,
			listener,
			1,
			POS_BACK,
			0,
			undefined,
			options?.signal,
		)
	}

	public many<K extends keyof E>(
		event: K,
		times: number,
		listener: EventListener<E[K]>,
		options?: SubscriptionOptions,
	): Unsubscribe {
		normalizeTimes(times)
		return this._add(
			event,
			listener,
			times,
			POS_BACK,
			0,
			undefined,
			options?.signal,
		)
	}

	protected _scope<K extends keyof E>(
		event: K,
		posKind: PositionKind,
		posValue: number | ((ctx: { count: number; event: K }) => number),
		predicate?: GuardPredicate<E[K]>,
	): EventureScope<E, K> {
		const add = (
			listener: EventListener<E[K]>,
			times: number,
			scopePosKind: PositionKind,
			scopePosValue: number | ((ctx: { count: number; event: K }) => number),
			scopePredicate?: GuardPredicate<E[K]>,
			signal?: AbortSignal,
		) =>
			this._add(
				event,
				listener,
				times,
				scopePosKind,
				scopePosValue,
				scopePredicate,
				signal,
			)
		return new EventureListenerScope(
			add,
			posKind,
			posValue,
			predicate,
		) as EventureScope<E, K>
	}

	public when<K extends keyof E>(
		event: K,
		predicate: GuardPredicate<E[K]>,
	): EventureScope<E, K> {
		return this._scope(event, POS_BACK, 0, predicate)
	}

	public at<K extends keyof E>(
		event: K,
		position: EventurePosition<E, K>,
	): EventureScope<E, K> {
		const [encodedKind, encodedValue] = encodeListenerPosition(position)
		return this._scope(event, encodedKind, encodedValue)
	}

	public waitFor<K extends keyof E>(
		event: K,
		options: EventureWaitForOptions<E, K> = {},
	): EventureWaitForPromise<E, K> {
		const register = (listener: EventListener<E[K]>) =>
			this._append(event, listener)
		return waitForSingle(this._wrap, register, options, String(event))
	}

	public fire<K extends keyof E>(
		event: K,
		...args: EventArgs<E[K]>
	): Generator<EventureFireSyncResult<E, K>>
	public fire<K extends keyof E>(
		event: K,
		...args: EventArgs<E[K]>
	): Generator<FireSyncRecord<E[K]>> {
		return fireFromListeners(this._readListeners(event), args)
	}

	public fireFrom<K extends keyof E>(
		listeners: EventListener<E[K]>[],
		...args: EventArgs<E[K]>
	): Generator<FireSyncRecord<E[K]>> {
		return fireFromListeners(listeners, args)
	}

	public fireAsync<K extends keyof E>(
		event: K,
		...args: EventArgs<E[K]>
	): AsyncGenerator<EventureFireAsyncResult<E, K>>
	public fireAsync<K extends keyof E>(
		event: K,
		...args: EventArgs<E[K]>
	): AsyncGenerator<FireAsyncRecord<E[K]>> {
		return fireAsyncFromListeners(this._readListeners(event), args)
	}

	public fireAsyncFrom<K extends keyof E>(
		listeners: EventListener<E[K]>[],
		...args: EventArgs<E[K]>
	): AsyncGenerator<FireAsyncRecord<E[K]>> {
		return fireAsyncFromListeners(listeners, args)
	}

	public waterfall<K extends WFKeys<E>>(
		event: K,
		...args: EventureSplit<E, K> extends never
			? never[]
			: [...EventureSplit<E, K>['args'], EventureSplit<E, K>['next']]
	): EventureWFResult<E, K>
	public waterfall<K extends WFKeys<E>>(
		event: K,
		...args: EventureSplit<E, K> extends never
			? never[]
			: EventureSplit<E, K>['args']
	): EventureWFResult<E, K>
	public waterfall(event: any, ...args: any[]): WFResult<any> {
		return runWaterfall(this._readListeners(event), args)
	}

	public waterfallFrom<K extends WFKeys<E>>(
		listeners: EventListener<E[K]>[],
		...args: EventureSplit<E, K> extends never
			? never[]
			: [...EventureSplit<E, K>['args'], EventureSplit<E, K>['next']]
	): EventureWFResult<E, K>
	public waterfallFrom<K extends WFKeys<E>>(
		listeners: EventListener<E[K]>[],
		...args: EventureSplit<E, K> extends never
			? never[]
			: EventureSplit<E, K>['args']
	): EventureWFResult<E, K>
	public waterfallFrom(
		listeners: EventListener<any>[],
		...args: any[]
	): WFResult<any> {
		return runWaterfall(listeners, args)
	}
}
