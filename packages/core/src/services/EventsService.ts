import { type Context, Injectable, symbols } from '@pluxel/context'
// EventsService.ts
import {
	EvtChannel as Channel,
	type EventArgs,
	type EventDescriptor,
	type EventEmitterOptions,
	type EventListener,
	Eventure,
	type OnOptions,
	type Unsubscribe,
} from 'eventure'
import type { CommitSummary, PluginIdentifier, PluginInstance } from '../plugins'

const serviceName = 'events' as const
declare module '@pluxel/context' {
	namespace Context {
		interface Config {
			[serviceName]?: EventEmitterOptions
		}
	}
	interface Context {
		[serviceName]: EventsService
		on: EventsService['on']
		onFront: EventsService['onFront']
		emit: EventsService['emit']
		emitWithContext: EventsService['emitWithContext']
	}
}

@Injectable({
	key: serviceName,
	methods: ['on', 'onFront', 'emit', 'emitWithContext'] as const,
})
export class EventsService extends Eventure<Events> {
	constructor(
		private ctx: Context,
		config?: EventEmitterOptions,
	) {
		const cfg: any = config ?? {}
		cfg.logger = ctx.logger
		super(cfg)
	}

	protected override _register<K$1 extends keyof Events>(
		event: K$1,
		listener: EventListener<Events[K$1]>,
		opts?: OnOptions,
		forcePrepend?: boolean,
	): Unsubscribe {
		;(listener as any)[symbols.ATTACH] = this.ctx
		const ret = super._register(event, listener, opts, forcePrepend)
		this.ctx.scope.collectEffect(ret)
		return ret
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

export class EvtChannel<D extends EventDescriptor> extends Channel<D> {
	constructor(
		private ctx: Context,
		config?: EventEmitterOptions,
	) {
		const cfg: any = config ?? {}
		cfg.logger = ctx.logger
		super(cfg)
	}

	protected override _register(
		listener: EventListener<D>,
		opts?: OnOptions,
		prepend?: boolean,
	): Unsubscribe {
		;(listener as any)[symbols.ATTACH] = this.ctx
		const ret = super._register(listener, opts, prepend)
		this.ctx.caller?.scope.collectEffect(ret)
		return ret
	}
}

export interface Events {
	onLoad: [string]
	beforeStart: [PluginInstance] // 启动前
	commitFailed: (failed: Set<PluginIdentifier>) => void
	afterCommit: (summary: CommitSummary) => void
	afterStart: [Context] // 启动成功
	startError: [Context, Error] // 启动失败
	resolveError: [PluginIdentifier, Error] // 构造/依赖解析失败（无 plugin ctx）
}

// biome-ignore lint/complexity/noBannedTypes: <explanation>
type ThisType = Object | Function
type FilterFunction = ((attachedCtx: Context) => boolean) | undefined
