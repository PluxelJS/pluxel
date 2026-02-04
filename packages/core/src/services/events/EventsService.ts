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
import type { CommitSummary, PluginIdentifier, PluginInstance } from '../../plugins'

const serviceName = 'events' as const
declare module '@pluxel/context' {
	namespace Context {
		interface Config {
			[serviceName]?: EventEmitterOptions<Events>
		}
	}
	interface Context {
		on: EventsService['on']
		onFront: EventsService['onFront']
		emit: EventsService['emit']
		emitWithContext: EventsService['emitWithContext']
	}
	namespace Context {
		interface Services {
			[serviceName]: EventsService
		}
	}
}

@Injectable({
	key: serviceName,
	methods: ['on', 'onFront', 'emit', 'emitWithContext'] as const,
})
export class EventsService extends Eventure<Events> {
	constructor(
		public ctx: Context,
		config?: EventEmitterOptions<Events>,
	) {
		const cfg: EventEmitterOptions<Events> = config ? { ...config } : {}
		// Use a stable LogTape logger instead of passing the ctx-bound LoggerService instance.
		cfg.logger = ctx.logger.with({ service: 'eventure' }) as unknown as EventEmitterOptions<Events>['logger']
		super(cfg)
	}

	protected override _register<K$1 extends keyof Events>(
		event: K$1,
		listener: EventListener<Events[K$1]>,
		opts?: OnOptions,
		forcePrepend?: boolean,
	): Unsubscribe {
		;(listener as unknown as { [symbols.ATTACH]?: Context })[symbols.ATTACH] = this.ctx
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
		// 1. 从 thisArg 上取出可选的过滤函数
		const filterFn = (thisArg as unknown as { [symbols.FILTER]?: FilterFunction })[symbols.FILTER]

		// 2. 拿到所有当前事件的 listeners（不是每次都重新 query 多次）
		const listeners = this.queryListeners(event)
		if (listeners.length === 0) return this

		// 3. 提前缓存符号引用，少一点属性查找开销
		const attachSym = symbols.ATTACH

		// 4. 遍历调用
		for (let i = 0; i < listeners.length; i++) {
			const fn = listeners[i]
			// 注册时存下的 ctx
			const attachedCtx =
				((fn as unknown as { [symbols.ATTACH]?: Context })[attachSym] as Context | undefined) ??
				this.ctx

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
		public ctx: Context,
		config?: EventEmitterOptions<Record<string, D>>,
	) {
		const cfg: EventEmitterOptions<Record<string, D>> = config ? { ...config } : {}
		cfg.logger = ctx.logger.with({ service: 'eventure' }) as unknown as EventEmitterOptions<Record<string, D>>['logger']
		super(cfg)
	}

	protected override _register(
		listener: EventListener<D>,
		opts?: OnOptions,
		prepend?: boolean,
	): Unsubscribe {
		;(listener as unknown as { [symbols.ATTACH]?: Context })[symbols.ATTACH] = this.ctx
		const ret = super._register(listener, opts, prepend)
		const effects = this.ctx.caller?.effects ?? this.ctx.effects
		effects.defer(ret as unknown as () => void)
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

type FilterFunction = ((attachedCtx: Context) => boolean) | undefined
