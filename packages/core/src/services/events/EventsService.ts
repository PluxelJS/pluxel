import { type Context as PluxelContext, symbols } from '@pluxel/context'
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

type ContextProvider = PluxelContext | (() => PluxelContext)

const REGISTRATION_METHODS = new Set<PropertyKey>([
	'on',
	'onFront',
	'onAt',
	'once',
	'onceFront',
	'many',
	'manyFront',
	'when',
	'waitFor',
	'limit',
])

/** Named, capability-owned event channel for explicit public protocols. */
export class EvtChannel<D extends EventDescriptor> extends BaseEvtChannel<D> {
	private readonly getCtx: () => PluxelContext
	private readonly callerViews = new WeakMap<PluxelContext, EvtChannel<D>>()
	private registrationOwner?: PluxelContext

	constructor(ctx: ContextProvider, config?: EventEmitterOptions<Record<string, D>>) {
		const getCtx = typeof ctx === 'function' ? ctx : () => ctx
		super(withEventLogger<Record<string, D>>(getCtx(), config))
		this.getCtx = getCtx
	}

	protected override _register(
		listener: EventListener<D>,
		opts?: OnOptions,
		prepend?: boolean,
	): Unsubscribe {
		const ctx = this.ctx
		;(listener as unknown as { [symbols.ATTACH]?: PluxelContext })[symbols.ATTACH] = ctx
		const unsubscribe = super._register(listener, opts, prepend)
		;(this.registrationOwner?.effects ?? ctx.caller?.effects ?? ctx.effects).defer(
			unsubscribe as unknown as () => void,
		)
		return unsubscribe
	}

	/** @internal Used by injected Plugin caller views; not an author-facing event API. */
	[CALLER_CONTEXT_BIND](caller: PluxelContext): EvtChannel<D> {
		const existing = this.callerViews.get(caller)
		if (existing) return existing
		const methods = new Map<PropertyKey, (...args: unknown[]) => unknown>()
		const view = new Proxy(this, {
			get: (target, property) => {
				const value = Reflect.get(target, property, target) as unknown
				if (typeof value !== 'function') return value
				const cached = methods.get(property)
				if (cached) return cached
				const invoke = REGISTRATION_METHODS.has(property)
					? (...args: unknown[]) => {
							const previous = this.registrationOwner
							this.registrationOwner = caller
							try {
								return Reflect.apply(value, this, args)
							} finally {
								this.registrationOwner = previous
							}
						}
					: (...args: unknown[]) => Reflect.apply(value, this, args)
				methods.set(property, invoke)
				return invoke
			},
		})
		this.callerViews.set(caller, view)
		return view
	}

	get ctx(): PluxelContext {
		return this.getCtx()
	}
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
