import type { Context as PluxelContext } from '../../context/Context'
import { CALLER_CONTEXT_BIND } from '../../plugins/composition/symbols'
import {
	EvtChannel as BaseEvtChannel,
	type EventDescriptor,
	type EventListener,
	type EvtChannelOptions,
	type EvtChannelPosition,
	type EvtChannelScope,
	type SubscriptionOptions,
	type Unsubscribe,
} from 'eventure'
import { deferEventCleanup, withEventLogger } from './event-support'

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
type EventPredicate<D extends EventDescriptor> = (
	...args: Parameters<EventListener<D>>
) => boolean | void

/** Named, capability-owned event channel for explicit public protocols. */
export class EvtChannel<D extends EventDescriptor> extends BaseEvtChannel<D> {
	readonly #ownerContext: PluxelContext
	private readonly callerViews = new WeakMap<PluxelContext, EvtChannel<D>>()
	private registrationOwner?: PluxelContext

	constructor(
		ctx: PluxelContext,
		config?: Readonly<{
			catchPromiseError?: boolean
			checkSyncFuncReturnPromise?: boolean
			errorPolicy?: EvtChannelOptions<D>['errorPolicy']
		}>,
	) {
		super(
			withEventLogger<Record<string, D>>(ctx, {
				captureRejections: config?.catchPromiseError,
				captureReturnedPromises: config?.checkSyncFuncReturnPromise,
				errorPolicy: config?.errorPolicy,
			}),
		)
		this.#ownerContext = ctx
	}

	get ctx(): PluxelContext {
		return this.#ownerContext
	}

	override on(
		listener: EventListener<D>,
		options?: SubscriptionOptions & { prepend?: boolean },
	): Unsubscribe {
		return options?.prepend
			? this.onFront(listener, { signal: options.signal })
			: this.ownSubscription(super.on(listener, options))
	}

	override once(
		listener: EventListener<D>,
		predicateOrOptions?: EventPredicate<D> | SubscriptionOptions,
	): Unsubscribe {
		return this.ownSubscription(
			typeof predicateOrOptions === 'function'
				? super.when(predicateOrOptions).once(listener)
				: super.once(listener, predicateOrOptions),
		)
	}

	override many(
		times: number,
		listener: EventListener<D>,
		predicateOrOptions?: EventPredicate<D> | SubscriptionOptions,
	): Unsubscribe {
		return this.ownSubscription(
			typeof predicateOrOptions === 'function'
				? super.when(predicateOrOptions).many(times, listener)
				: super.many(times, listener, predicateOrOptions),
		)
	}

	override when(predicate?: EventPredicate<D>): EvtChannelScope<D> {
		return this.ownedScope(super.when(predicate ?? (() => true)))
	}

	override at(position: EvtChannelPosition): EvtChannelScope<D> {
		return this.ownedScope(super.at(position))
	}

	onFront(listener: EventListener<D>, options?: SubscriptionOptions): Unsubscribe {
		return this.at('front').on(listener, options)
	}

	onAt(
		options: { at: number | ((ctx: { count: number }) => number); signal?: AbortSignal },
		listener: EventListener<D>,
	): Unsubscribe {
		return this.at(options.at).on(listener, { signal: options.signal })
	}

	onceFront(listener: EventListener<D>, predicate?: EventPredicate<D>): Unsubscribe {
		const scope = this.at('front')
		return predicate ? scope.when(predicate).once(listener) : scope.once(listener)
	}

	manyFront(times: number, listener: EventListener<D>, predicate?: EventPredicate<D>): Unsubscribe {
		const scope = this.at('front')
		return predicate ? scope.when(predicate).many(times, listener) : scope.many(times, listener)
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
		deferEventCleanup(this.registrationOwner ?? ctx.caller ?? ctx, unsubscribe)
		return unsubscribe
	}

	private ownedScope(scope: EvtChannelScope<D>): EvtChannelScope<D> {
		return Object.freeze({
			on: (listener: EventListener<D>, options?: SubscriptionOptions) =>
				this.ownSubscription(scope.on(listener, options)),
			once: (listener: EventListener<D>, options?: SubscriptionOptions) =>
				this.ownSubscription(scope.once(listener, options)),
			many: (times: number, listener: EventListener<D>, options?: SubscriptionOptions) =>
				this.ownSubscription(scope.many(times, listener, options)),
			when: (predicate: EventPredicate<D>) => this.ownedScope(scope.when(predicate)),
			at: (position: EvtChannelPosition) => this.ownedScope(scope.at(position)),
		})
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
					property === 'when' || property === 'at'
						? (...args: unknown[]) =>
								bindChannelScope(Reflect.apply(method, source, args), invokeWithOwner)
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

function bindChannelScope(value: unknown, invokeWithOwner: InvokeWithOwner): unknown {
	if (!value || typeof value !== 'object') return value
	const scope = value as Record<'on' | 'once' | 'many' | 'when' | 'at', Function>
	return Object.freeze({
		on: (...args: unknown[]) => invokeWithOwner(scope.on, scope, args),
		once: (...args: unknown[]) => invokeWithOwner(scope.once, scope, args),
		many: (...args: unknown[]) => invokeWithOwner(scope.many, scope, args),
		when: (...args: unknown[]) =>
			bindChannelScope(invokeWithOwner(scope.when, scope, args), invokeWithOwner),
		at: (...args: unknown[]) =>
			bindChannelScope(invokeWithOwner(scope.at, scope, args), invokeWithOwner),
	})
}
