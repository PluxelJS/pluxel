import type { Context as PluxelContext } from '../../context/Context'
import {
	Eventure,
	type EmitSettledRecord,
	type ErrorPolicy,
	type EventArgs,
	type EventDescriptor,
	type EventListener,
	type EventResult,
	type EventureOptions,
	type EventureWaitForOptions,
	type EventureWaitForPromise,
	type Unsubscribe,
} from 'eventure'
import { pinOwnerContext } from '../../context/owner-view'
import { deferEventCleanup, withEventLogger } from './event-support'

/**
 * Ambient event vocabulary shared by a Core host.
 *
 * Plugin packages extend this interface through module augmentation of `@pluxel/core`.
 */
export interface Events {}

export type EventsServiceConfig = Readonly<{
	readonly events?: readonly (keyof Events)[]
	readonly catchPromiseError?: boolean
	readonly checkSyncFuncReturnPromise?: boolean
	readonly errorPolicy?: ErrorPolicy
}>

type OnOptions = Readonly<{ prepend?: boolean; signal?: AbortSignal }>

type EventPredicate<D extends EventDescriptor> = (...args: EventArgs<D>) => boolean | void

export interface EventsWhenGuard<D extends EventDescriptor> {
	once(listener: EventListener<D>): Unsubscribe
	onceFront(listener: EventListener<D>): Unsubscribe
	many(times: number, listener: EventListener<D>): Unsubscribe
	manyFront(times: number, listener: EventListener<D>): Unsubscribe
}

export interface EventsService {
	readonly ctx: PluxelContext
	on<K extends keyof Events>(
		event: K,
		listener: EventListener<Events[K]>,
		opts?: OnOptions,
	): Unsubscribe
	onFront<K extends keyof Events>(
		event: K,
		listener: EventListener<Events[K]>,
		opts?: Omit<OnOptions, 'prepend'>,
	): Unsubscribe
	onAt<K extends keyof Events>(
		event: K,
		options: {
			at: number | ((ctx: { count: number; event: K }) => number)
			signal?: AbortSignal
		},
		listener: EventListener<Events[K]>,
	): Unsubscribe
	off<K extends keyof Events>(event: K, listener: EventListener<Events[K]>): boolean
	once<K extends keyof Events>(
		event: K,
		listener: EventListener<Events[K]>,
		predicate?: EventPredicate<Events[K]>,
	): Unsubscribe
	onceFront<K extends keyof Events>(
		event: K,
		listener: EventListener<Events[K]>,
		predicate?: EventPredicate<Events[K]>,
	): Unsubscribe
	many<K extends keyof Events>(
		event: K,
		times: number,
		listener: EventListener<Events[K]>,
		predicate?: EventPredicate<Events[K]>,
	): Unsubscribe
	manyFront<K extends keyof Events>(
		event: K,
		times: number,
		listener: EventListener<Events[K]>,
		predicate?: EventPredicate<Events[K]>,
	): Unsubscribe
	when<K extends keyof Events>(
		event: K,
		predicate?: EventPredicate<Events[K]>,
	): EventsWhenGuard<Events[K]>
	waitFor<K extends keyof Events>(
		event: K,
		options?: EventureWaitForOptions<Events, K>,
	): EventureWaitForPromise<Events, K>
	emit<K extends keyof Events>(event: K, ...args: EventArgs<Events[K]>): number
	emitAll<K extends keyof Events>(
		event: K,
		...args: EventArgs<Events[K]>
	): Promise<Awaited<EventResult<Events[K]>>[]>
	emitSettled<K extends keyof Events>(
		event: K,
		...args: EventArgs<Events[K]>
	): Promise<EmitSettledRecord<EventListener<Events[K]>, Awaited<EventResult<Events[K]>>>[]>
}

/**
 * One owner-bound view over the root ambient event bus.
 *
 * Emission is host-wide; every subscription is owned by the registering Context effects scope.
 */
class EventsServiceView implements EventsService {
	readonly ctx!: PluxelContext
	readonly #backend: Eventure<Events>

	constructor(ctx: PluxelContext, backend: Eventure<Events>) {
		pinOwnerContext(this, ctx)
		this.#backend = backend
		Object.preventExtensions(this)
	}

	on<K extends keyof Events>(
		event: K,
		listener: EventListener<Events[K]>,
		opts?: OnOptions,
	): Unsubscribe {
		return opts?.prepend
			? this.onFront(event, listener, { signal: opts.signal })
			: this.ownSubscription(this.#backend.on(event, listener, opts))
	}

	onFront<K extends keyof Events>(
		event: K,
		listener: EventListener<Events[K]>,
		opts?: Omit<OnOptions, 'prepend'>,
	): Unsubscribe {
		return this.ownSubscription(this.#backend.at(event, 'front').on(listener, opts))
	}

	onAt<K extends keyof Events>(
		event: K,
		options: {
			at: number | ((ctx: { count: number; event: K }) => number)
			signal?: AbortSignal
		},
		listener: EventListener<Events[K]>,
	): Unsubscribe {
		return this.ownSubscription(
			this.#backend.at(event, options.at).on(listener, { signal: options.signal }),
		)
	}

	off<K extends keyof Events>(event: K, listener: EventListener<Events[K]>): boolean {
		return this.#backend.off(event, listener)
	}

	once<K extends keyof Events>(
		event: K,
		listener: EventListener<Events[K]>,
		predicate?: EventPredicate<Events[K]>,
	): Unsubscribe {
		return this.ownSubscription(
			predicate
				? this.#backend.when(event, predicate).once(listener)
				: this.#backend.once(event, listener),
		)
	}

	onceFront<K extends keyof Events>(
		event: K,
		listener: EventListener<Events[K]>,
		predicate?: EventPredicate<Events[K]>,
	): Unsubscribe {
		const scope = this.#backend.at(event, 'front')
		return this.ownSubscription(
			predicate ? scope.when(predicate).once(listener) : scope.once(listener),
		)
	}

	many<K extends keyof Events>(
		event: K,
		times: number,
		listener: EventListener<Events[K]>,
		predicate?: EventPredicate<Events[K]>,
	): Unsubscribe {
		return this.ownSubscription(
			predicate
				? this.#backend.when(event, predicate).many(times, listener)
				: this.#backend.many(event, times, listener),
		)
	}

	manyFront<K extends keyof Events>(
		event: K,
		times: number,
		listener: EventListener<Events[K]>,
		predicate?: EventPredicate<Events[K]>,
	): Unsubscribe {
		const scope = this.#backend.at(event, 'front')
		return this.ownSubscription(
			predicate ? scope.when(predicate).many(times, listener) : scope.many(times, listener),
		)
	}

	when<K extends keyof Events>(
		event: K,
		predicate?: EventPredicate<Events[K]>,
	): EventsWhenGuard<Events[K]> {
		const condition = predicate ?? (() => true)
		return Object.freeze({
			once: (listener: EventListener<Events[K]>) =>
				this.ownSubscription(this.#backend.when(event, condition).once(listener)),
			onceFront: (listener: EventListener<Events[K]>) =>
				this.ownSubscription(this.#backend.at(event, 'front').when(condition).once(listener)),
			many: (times: number, listener: EventListener<Events[K]>) =>
				this.ownSubscription(this.#backend.when(event, condition).many(times, listener)),
			manyFront: (times: number, listener: EventListener<Events[K]>) =>
				this.ownSubscription(
					this.#backend.at(event, 'front').when(condition).many(times, listener),
				),
		})
	}

	waitFor<K extends keyof Events>(
		event: K,
		options?: EventureWaitForOptions<Events, K>,
	): EventureWaitForPromise<Events, K> {
		const pending = this.#backend.waitFor(event, options)
		this.ownCleanup(pending.cancel)
		return pending
	}

	emit<K extends keyof Events>(event: K, ...args: EventArgs<Events[K]>): number {
		return this.#backend.emit(event, ...args)
	}

	emitAll<K extends keyof Events>(
		event: K,
		...args: EventArgs<Events[K]>
	): Promise<Awaited<EventResult<Events[K]>>[]> {
		return this.#backend.emitAll(event, ...args)
	}

	emitSettled<K extends keyof Events>(
		event: K,
		...args: EventArgs<Events[K]>
	): Promise<EmitSettledRecord<EventListener<Events[K]>, Awaited<EventResult<Events[K]>>>[]> {
		return this.#backend.emitSettled(event, ...args)
	}

	private ownSubscription(unsubscribe: Unsubscribe): Unsubscribe {
		this.ownCleanup(unsubscribe)
		return unsubscribe
	}

	private ownCleanup(cleanup: () => void): void {
		deferEventCleanup(this.ctx.caller ?? this.ctx, cleanup)
	}
}

/** @internal Root backing factory used by the compiled Core Context plan. */
export function createEventsBackend(
	ctx: PluxelContext,
	config?: EventsServiceConfig,
): Eventure<Events> {
	let backendConfig: EventureOptions<Events> | undefined
	if (config) {
		const { events, catchPromiseError, checkSyncFuncReturnPromise, ...options } = config
		backendConfig = {
			...options,
			captureRejections: catchPromiseError,
			captureReturnedPromises: checkSyncFuncReturnPromise,
			...(events ? { preallocateEvents: [...events] } : {}),
		}
	}
	return new Eventure(withEventLogger(ctx, backendConfig))
}

/** @internal Owner-view factory used by the compiled Core Context plan. */
export function createEventsServiceView(
	backend: Eventure<Events>,
	ctx: PluxelContext,
): EventsService {
	return new EventsServiceView(ctx, backend)
}
