import { type Context as PluxelContext, Injectable, symbols } from '@pluxel/context'
import {
	EvtChannel as BaseEvtChannel,
	type EventArgs,
	type EventDescriptor,
	type EventEmitterOptions,
	type EventListener,
	Eventure,
	type IEventMap,
	type OnOptions,
	type Unsubscribe,
} from 'eventure'
import type {
	CommitSummary,
	PluginIdentifier,
	PluginInstance,
	RuntimePluginKey,
} from '../../plugins'

const serviceName = 'events' as const

export type ResolverCacheInvalidatedEvent = {
	by?: string
	reason?: string
	targets?: readonly string[]
}

type InternalEvents = {
	runtimeCommitted: EvtChannel<[summary: CommitSummary]>
	resolverCacheInvalidated: EvtChannel<[event?: ResolverCacheInvalidatedEvent]>
}

declare module '@pluxel/context' {
	namespace Context {
		interface Config {
			[serviceName]?: EventEmitterOptions<Events>
		}
		interface Services {
			[serviceName]: EventsService
		}
	}
	interface Context {
		readonly internalEvent: EventsService['internalEvent']
		on: EventsService['on']
		onFront: EventsService['onFront']
		emit: EventsService['emit']
		emitWithContext: EventsService['emitWithContext']
	}
}

@Injectable({
	key: serviceName,
	methods: ['on', 'onFront', 'emit', 'emitWithContext'] as const,
	props: ['internalEvent'] as const,
})
export class EventsService extends Eventure<Events> {
	readonly internalEvent: InternalEvents

	constructor(
		public ctx: PluxelContext,
		config?: EventEmitterOptions<Events>,
	) {
		super(withEventLogger<Events>(ctx, config))
		this.internalEvent = {
			runtimeCommitted: new EvtChannel(() => this.ctx),
			resolverCacheInvalidated: new EvtChannel(() => this.ctx),
		}
	}

	protected override _register<K$1 extends keyof Events>(
		event: K$1,
		listener: EventListener<Events[K$1]>,
		opts?: OnOptions,
		forcePrepend?: boolean,
	): Unsubscribe {
		;(listener as unknown as { [symbols.ATTACH]?: PluxelContext })[symbols.ATTACH] = this.ctx
		const ret = super._register(event, listener, opts, forcePrepend)
		const effects = this.ctx.caller?.effects ?? this.ctx.effects
		effects.defer(ret as unknown as () => void)
		return ret
	}

	emitWithContext<K extends keyof Events>(
		thisArg: unknown,
		event: K,
		...args: EventArgs<Events[K]>
	): this {
		const filterFn = (thisArg as unknown as { [symbols.FILTER]?: FilterFunction })[symbols.FILTER]
		const listeners = this.queryListeners(event)
		if (listeners.length === 0) return this

		const attachSym = symbols.ATTACH

		for (let i = 0; i < listeners.length; i++) {
			const fn = listeners[i]
			const attachedCtx =
				((fn as unknown as { [symbols.ATTACH]?: PluxelContext })[attachSym] as
					| PluxelContext
					| undefined) ?? this.ctx

			if (!filterFn || filterFn.call(thisArg, attachedCtx)) {
				fn.call(thisArg, ...args)
			}
		}

		return this
	}
}

type ContextProvider = PluxelContext | (() => PluxelContext)

export class EvtChannel<D extends EventDescriptor> extends BaseEvtChannel<D> {
	private readonly getCtx: () => PluxelContext

	constructor(ctx: ContextProvider, config?: EventEmitterOptions<Record<string, D>>) {
		const getCtx = toContextProvider(ctx)
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
		const ret = super._register(listener, opts, prepend)
		const effects = ctx.caller?.effects ?? ctx.effects
		effects.defer(ret as unknown as () => void)
		return ret
	}

	get ctx() {
		return this.getCtx()
	}
}

export interface Events {
	onLoad: [string]
	beforeStart: [PluginInstance] // 启动前
	afterStart: [PluxelContext] // 启动成功
	startError: [PluxelContext, Error] // 启动失败
	resolveError: [PluginIdentifier | RuntimePluginKey, Error] // 构造/依赖解析失败（无 plugin ctx）
}

type FilterFunction = (attachedCtx: PluxelContext) => boolean

function withEventLogger<T extends IEventMap<T>>(
	ctx: PluxelContext,
	config?: EventEmitterOptions<T>,
): EventEmitterOptions<T> {
	return {
		...config,
		logger: ctx.logger.with({ service: 'eventure' }) as unknown as EventEmitterOptions<T>['logger'],
	}
}

function toContextProvider(ctx: ContextProvider): () => PluxelContext {
	return typeof ctx === 'function' ? ctx : () => ctx
}
