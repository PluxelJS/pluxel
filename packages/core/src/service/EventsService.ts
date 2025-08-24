import { type Context, Injectable, symbols } from '@pluxel/context'
// EventsService.ts
import {
	type EventArgs,
	type EventEmitterOptions,
	type EventListener,
	Eventure,
	type Unsubscribe,
} from 'eventure'
import type {
	PluginConstructor,
	PluginIdentifier,
	PluginInstance,
} from '../pluginImpl'

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

@Injectable({
	key: 'events',
	methods: ['on', 'prependOn', 'emit', 'emitWithContext'] as const,
})
export class EventsService extends Eventure<Events> {
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
		;(listener as any)[symbols.ATTACH] = this.ctx
		const unsub = super.addListener(event, listener, true)
		this.ctx.scope.collectEffect(unsub)
		return returnUnsub ? unsub : this
	}
	// @ts-ignore
	override prependOn: typeof this.prependListener = (
		event,
		listener,
		returnUnsub = false,
	) => {
		;(listener as any)[symbols.ATTACH] = this.ctx
		const unsub = super.prependListener(event, listener, true)
		this.ctx.scope.collectEffect(unsub)
		return returnUnsub ? unsub : this
	}

	emitWithContext<K extends keyof Events>(
		thisArg: unknown,
		event: K,
		...args: EventArgs<Events[K]>
	): this {
		// 1. 从 thisArg 上取出可选的过滤函数
		const filterFn = (thisArg as any)[symbols.FILTER] as FilterFunction

		// 2. 拿到所有当前事件的 listeners（不是每次都重新 query 多次）
		const listeners = this.queryListeners(event)
		if (listeners.length === 0) return this

		// 3. 提前缓存符号引用，少一点属性查找开销
		const attachSym = symbols.ATTACH

		// 4. 遍历调用
		for (let i = 0; i < listeners.length; i++) {
			const fn = listeners[i]
			// 注册时存下的 ctx
			const attachedCtx = (fn as any)[attachSym] as Context

			// 如果有 filterFn，就用它判断；否则直接调用
			if (!filterFn || filterFn.call(thisArg, attachedCtx)) {
				// 以 thisArg 为 this，且不重新 bind，直接调用
				fn.call(thisArg, ...args)
			}
		}

		return this
	}
}

export interface Events {
	onLoad: [string]
	beforeStart: [PluginInstance] // 启动前
	commitFailed: (failed: Set<PluginIdentifier>) => void
	afterStart: [Context] // 启动成功
	startError: [Context, Error] // 启动失败
}

// biome-ignore lint/complexity/noBannedTypes: <explanation>
type ThisType = Object | Function
type FilterFunction = ((attachedCtx: Context) => boolean) | undefined
