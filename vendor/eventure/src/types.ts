// types.ts
import type { Logger } from './logger'

export type EventDescriptor = readonly [...any[]] | ((...args: any[]) => any)

export type IEventMap<T> = { [K in keyof T]: EventDescriptor }

/** —— 工具类型 —— */
export type EventArgs<D extends EventDescriptor> = D extends (
	...args: infer A
) => any
	? A
	: D extends readonly [...infer T]
		? T
		: never

export type Awaitable<T> = T | Promise<T>
export type EventResult<D extends EventDescriptor> = D extends (
	...args: any[]
) => infer R
	? R
	: void

export type EventListener<D extends EventDescriptor> = (
	...args: EventArgs<D>
) => EventResult<D>

export type UnsubscribeFunction = () => void
type DisposeSymbol = typeof Symbol extends { readonly dispose: infer S }
	? S extends symbol
		? S
		: symbol
	: symbol
export type Unsubscribe = UnsubscribeFunction & {
	[K in DisposeSymbol]?: () => void
}

export type EmitSettledRecord<Fn, Value> =
	| { fn: Fn; status: 'fulfilled'; value: Value }
	| { fn: Fn; status: 'rejected'; reason: unknown }

export type ListenerPosition<Ctx = unknown> =
	| 'front'
	| 'back'
	| number
	| ((ctx: Ctx) => number)

/** —— 订阅参数：只保留横切生命周期控制，监听语义由 API 表达 —— */
export interface SubscriptionOptions {
	/** 绑定 AbortSignal，触发后自动退订 */
	signal?: AbortSignal
}

/** —— 运行时错误策略 —— */
export type ErrorPolicy = 'silent' | 'log' | 'throw'

/** —— 监听器包裹策略（供 core/listener 与构造参数共享） —— */
export interface ListenerWrapPolicy {
	/** 是否捕获/规避异步监听器的 rejection（默认 true） */
	captureRejections?: boolean
	/** 是否检查非 async listener 返回的 Promise（默认 false） */
	captureReturnedPromises?: boolean
	/** 同步/异步错误处理策略（默认 'log'） */
	errorPolicy?: ErrorPolicy
}

/** —— Eventure 构造参数：继承策略类型，附加 logger & 事件预分配 —— */
export interface EventureOptions<
	E extends { [K in keyof E]: EventDescriptor } = Record<
		string | symbol,
		EventDescriptor
	>,
> extends ListenerWrapPolicy {
	logger?: Logger
	/** 如果提供，就会在构造时预先为这些事件名分配 listener 数组 */
	preallocateEvents?: (keyof E)[]
}
