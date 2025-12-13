import type { RpcExtensions as ServicesRpcExtensions, SseEvents as ServicesSseEvents } from './extensions'

/**
 * Bridge: 让 `@pluxel/hmr-web` 的 `RpcExtensions`/`SseEvents` 自动包含
 * `@pluxel/hmr/services` 的扩展。
 *
 * 目标：插件只需要依赖 `@pluxel/hmr`，不需要直接依赖 `@pluxel/hmr-web`。
 */
declare module '@pluxel/hmr-web' {
	// biome-ignore lint/suspicious/noEmptyInterface: declaration merging target
	interface RpcExtensions extends ServicesRpcExtensions {}
	// biome-ignore lint/suspicious/noEmptyInterface: declaration merging target
	interface SseEvents extends ServicesSseEvents {}
}

