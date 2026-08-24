import type { Context as PluxelContext } from '../../context/Context'
import {
	EvtChannel as BaseEvtChannel,
	Eventure,
	type EmitSettledRecord,
	type EventArgs,
	type EventDescriptor,
	type EventEmitterOptions,
	type EventListener,
	type EventResult,
	type EventureWaitForOptions,
	type EventureWaitForPromise,
	type IEventMap,
	type OnOptions,
	type Unsubscribe,
} from 'eventure'
import { CALLER_CONTEXT_BIND } from '../../plugins/composition/symbols'
import { pinOwnerContext } from '../../context/owner-view'

/**
 * Ambient event vocabulary shared by a Core host.
 *
 * Plugin packages extend this interface through module augmentation of `@pluxel/core`.
 */
export interface Events {}

export type EventsServiceConfig = Readonly<
	Omit<EventEmitterOptions<Events>, 'events' | 'logger'> & {
		readonly events?: readonly (keyof Events)[]
	}
>

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

const EVENTS_BACKENDS = new WeakMap<object, Eventure<Events>>()

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
		EVENTS_BACKENDS.set(this, backend)
		Object.preventExtensions(this)
	}

	on<K extends keyof Events>(
		event: K,
		listener: EventListener<Events[K]>,
		opts?: OnOptions,
	): Unsubscribe {
		return this.ownSubscription(this.#backend.on(event, listener, opts))
	}

	onFront<K extends keyof Events>(
		event: K,
		listener: EventListener<Events[K]>,
		opts?: Omit<OnOptions, 'prepend'>,
	): Unsubscribe {
		return this.ownSubscription(this.#backend.onFront(event, listener, opts))
	}

	onAt<K extends keyof Events>(
		event: K,
		options: {
			at: number | ((ctx: { count: number; event: K }) => number)
			signal?: AbortSignal
		},
		listener: EventListener<Events[K]>,
	): Unsubscribe {
		return this.ownSubscription(this.#backend.onAt(event, options, listener))
	}

	off<K extends keyof Events>(event: K, listener: EventListener<Events[K]>): boolean {
		return this.#backend.off(event, listener)
	}

	once<K extends keyof Events>(
		event: K,
		listener: EventListener<Events[K]>,
		predicate?: EventPredicate<Events[K]>,
	): Unsubscribe {
		return this.ownSubscription(this.#backend.once(event, listener, predicate))
	}

	onceFront<K extends keyof Events>(
		event: K,
		listener: EventListener<Events[K]>,
		predicate?: EventPredicate<Events[K]>,
	): Unsubscribe {
		return this.ownSubscription(this.#backend.onceFront(event, listener, predicate))
	}

	many<K extends keyof Events>(
		event: K,
		times: number,
		listener: EventListener<Events[K]>,
		predicate?: EventPredicate<Events[K]>,
	): Unsubscribe {
		return this.ownSubscription(this.#backend.many(event, times, listener, predicate))
	}

	manyFront<K extends keyof Events>(
		event: K,
		times: number,
		listener: EventListener<Events[K]>,
		predicate?: EventPredicate<Events[K]>,
	): Unsubscribe {
		return this.ownSubscription(this.#backend.manyFront(event, times, listener, predicate))
	}

	when<K extends keyof Events>(
		event: K,
		predicate?: EventPredicate<Events[K]>,
	): EventsWhenGuard<Events[K]> {
		const guard = this.#backend.when(event, predicate)
		return Object.freeze({
			once: (listener: EventListener<Events[K]>) => this.ownSubscription(guard.once(listener)),
			onceFront: (listener: EventListener<Events[K]>) =>
				this.ownSubscription(guard.onceFront(listener)),
			many: (times: number, listener: EventListener<Events[K]>) =>
				this.ownSubscription(guard.many(times, listener)),
			manyFront: (times: number, listener: EventListener<Events[K]>) =>
				this.ownSubscription(guard.manyFront(times, listener)),
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
		try {
			;(this.ctx.caller?.effects ?? this.ctx.effects).defer(cleanup)
		} catch (error) {
			try {
				cleanup()
			} catch {
				// Preserve the ownership failure; cleanup is best-effort registration rollback.
			}
			throw error
		}
	}
}

/** @internal Root backing factory used by the compiled Core Context plan. */
export function createRootEventsService(
	ctx: PluxelContext,
	config?: EventsServiceConfig,
): EventsService {
	let backendConfig: EventEmitterOptions<Events> | undefined
	if (config) {
		const { events, ...options } = config
		backendConfig = { ...options, ...(events ? { events: [...events] } : {}) }
	}
	return new EventsServiceView(ctx, new Eventure(withEventLogger(ctx, backendConfig)))
}

/** @internal Owner-view factory used by the compiled Core Context plan. */
export function createEventsServiceView(root: EventsService, ctx: PluxelContext): EventsService {
	const backend = EVENTS_BACKENDS.get(root)
	if (!backend) throw new TypeError('[pluxel/core] Invalid root EventsService')
	return new EventsServiceView(ctx, backend)
}

const REGISTRATION_METHODS = new Set<PropertyKey>([
	'on',
	'onFront',
	'onAt',
	'once',
	'onceFront',
	'many',
	'manyFront',
	'waitFor',
])

type InvokeWithOwner = (method: Function, receiver: unknown, args: readonly unknown[]) => unknown

/** Named, capability-owned event channel for explicit public protocols. */
export class EvtChannel<D extends EventDescriptor> extends BaseEvtChannel<D> {
	readonly #ownerContext: PluxelContext
	private readonly callerViews = new WeakMap<PluxelContext, EvtChannel<D>>()
	private registrationOwner?: PluxelContext

	constructor(ctx: PluxelContext, config?: EventEmitterOptions<Record<string, D>>) {
		super(withEventLogger<Record<string, D>>(ctx, config))
		this.#ownerContext = ctx
	}

	get ctx(): PluxelContext {
		return this.#ownerContext
	}

	protected override _register(
		listener: EventListener<D>,
		opts?: OnOptions,
		prepend?: boolean,
	): Unsubscribe {
		return this.ownSubscription(super._register(listener, opts, prepend))
	}

	override onAt(
		options: { at: number | ((ctx: { count: number }) => number); signal?: AbortSignal },
		listener: EventListener<D>,
	): Unsubscribe {
		return this.ownSubscription(super.onAt(options, listener))
	}

	/** @internal Used by injected Plugin caller views; not an author-facing event API. */
	[CALLER_CONTEXT_BIND](caller: PluxelContext): EvtChannel<D> {
		const existing = this.callerViews.get(caller)
		if (existing) return existing
		const invokeWithOwner: InvokeWithOwner = (method, receiver, args) => {
			const previous = this.registrationOwner
			this.registrationOwner = caller
			try {
				return Reflect.apply(method, receiver, args)
			} finally {
				this.registrationOwner = previous
			}
		}
		const view = createCallerChannelView(this, invokeWithOwner)
		this.callerViews.set(caller, view)
		return view
	}

	private ownSubscription(unsubscribe: Unsubscribe): Unsubscribe {
		const ctx = this.ctx
		try {
			;(this.registrationOwner?.effects ?? ctx.caller?.effects ?? ctx.effects).defer(
				unsubscribe as unknown as () => void,
			)
			return unsubscribe
		} catch (error) {
			try {
				unsubscribe()
			} catch {
				// Preserve the ownership failure; the subscription cleanup is best-effort rollback.
			}
			throw error
		}
	}
}

/** Compile one ordinary, cached facade so hot channel operations remain Proxy-free. */
function createCallerChannelView<D extends EventDescriptor>(
	source: EvtChannel<D>,
	invokeWithOwner: InvokeWithOwner,
): EvtChannel<D> {
	const view = Object.create(Object.getPrototypeOf(source)) as EvtChannel<D>
	const defined = new Set<PropertyKey>()
	let prototype = Object.getPrototypeOf(source) as object | null
	while (prototype && prototype !== Object.prototype) {
		for (const property of Reflect.ownKeys(prototype)) {
			if (property === 'constructor' || defined.has(property)) continue
			defined.add(property)
			const descriptor = Reflect.getOwnPropertyDescriptor(prototype, property)
			if (!descriptor) continue
			if ('value' in descriptor && typeof descriptor.value === 'function') {
				const method = descriptor.value as Function
				const value =
					property === 'when'
						? (...args: unknown[]) =>
								bindWhenGuard(Reflect.apply(method, source, args), invokeWithOwner)
						: REGISTRATION_METHODS.has(property)
							? (...args: unknown[]) => invokeWithOwner(method, source, args)
							: (...args: unknown[]) => Reflect.apply(method, source, args)
				Object.defineProperty(view, property, {
					value,
					writable: false,
					configurable: false,
				})
				continue
			}
			Object.defineProperty(view, property, {
				get: descriptor.get ? () => Reflect.apply(descriptor.get!, source, []) : undefined,
				set: descriptor.set
					? (value: unknown) => Reflect.apply(descriptor.set!, source, [value])
					: undefined,
				configurable: false,
			})
		}
		prototype = Object.getPrototypeOf(prototype) as object | null
	}
	return Object.preventExtensions(view)
}

function bindWhenGuard(value: unknown, invokeWithOwner: InvokeWithOwner): unknown {
	if (!value || typeof value !== 'object') return value
	const guard = value as Record<'once' | 'onceFront' | 'many' | 'manyFront', Function>
	return Object.freeze({
		once: (...args: unknown[]) => invokeWithOwner(guard.once, guard, args),
		onceFront: (...args: unknown[]) => invokeWithOwner(guard.onceFront, guard, args),
		many: (...args: unknown[]) => invokeWithOwner(guard.many, guard, args),
		manyFront: (...args: unknown[]) => invokeWithOwner(guard.manyFront, guard, args),
	})
}

function withEventLogger<T extends IEventMap<T>>(
	ctx: PluxelContext,
	config?: EventEmitterOptions<T>,
): EventEmitterOptions<T> {
	return {
		...config,
		logger: ctx.logger.with({ service: 'eventure' }) as unknown as EventEmitterOptions<T>['logger'],
	}
}
