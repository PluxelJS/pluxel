import { type Context, Injectable, symbols } from '@pluxel/context'
// EventsService.ts
import {
	type EventArgs,
	type EventEmitterOptions,
	type EventListener,
	Eventure,
	type Unsubscribe,
} from 'eventure'

declare module '@pluxel/context' {
	namespace Context {
		interface Config {
			events?: EventEmitterOptions
		}
	}
	interface Context {
		/** Service 实例 */
		events: EventsService
		on: EventsService['on']
		prependOn: EventsService['prependOn']
		emit: EventsService['emit']
		emitWithContext: EventsService['emitWithContext']
	}
}

@Injectable
export class EventsService extends Eventure<Events> {
	static key = 'events'
	static methods = ['on', 'prependOn', 'emitWithContext'] as const

	constructor(
		private ctx: Context,
		private config: EventEmitterOptions,
	) {
		super(config as any)
	}

	// @ts-ignore
	override on: typeof this.addListener = (
		event,
		listener,
		returnUnsub = false,
	) => {
		Object.defineProperty(listener, symbols.ATTACH, this.ctx)
		console.log('checkpoint')
		const unsub = super.addListener(event, listener, true)
		this.ctx.collect(unsub)
		return returnUnsub ? unsub : this
	}
	// @ts-ignore
	override prependOn: typeof this.prependListener = (
		event,
		listener,
		returnUnsub = false,
	) => {
		const unsub = super.prependListener(event, listener, true)
		this.ctx.collect(unsub)
		return returnUnsub ? unsub : this
	}

	emitWithContext<K extends keyof Events>(
		thisArg: ThisType,
		event: K,
		...args: EventArgs<Events[K]>
	): this {
		const filter = (thisArg as any)?.[symbols.FILTER]
		const fns = this.queryListeners(event)
			.filter(
				(fn) => !filter || filter.call(thisArg, (fn as any)[symbols.ATTACH]),
			)
			.map((fn) => fn.bind(thisArg))
		for (const fn of fns) {
			fn(...args)
		}
		return this
	}
}

export interface Events {
	onLoad: [string]
}

// biome-ignore lint/complexity/noBannedTypes: <explanation>
type ThisType = Object | Function
