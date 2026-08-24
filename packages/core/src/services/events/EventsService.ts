import type { Context as PluxelContext } from '../../context/Context'
import {
	EvtChannel as BaseEvtChannel,
	type EventDescriptor,
	type EventEmitterOptions,
	type EventListener,
	type IEventMap,
	type OnOptions,
	type Unsubscribe,
} from 'eventure'
import { CALLER_CONTEXT_BIND } from '../../plugins/composition/symbols'

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
