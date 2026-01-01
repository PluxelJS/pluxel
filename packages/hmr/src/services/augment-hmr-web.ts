import type { UI as ServicesUI } from './plugin-interaction'

/**
 * Bridge: 让 `@pluxel/hmr-web` 的 `UI.rpc`/`UI.sse` 自动包含
 * `@pluxel/hmr/services` 的扩展（插件只依赖 @pluxel/hmr 即可）。
 *
 * 目标：插件只需要依赖 `@pluxel/hmr`，不需要直接依赖 `@pluxel/hmr-web`。
 */
declare module '@pluxel/hmr-web' {
	namespace UI {
		// biome-ignore lint/suspicious/noEmptyInterface: declaration merging bridge
		interface rpc extends ServicesUI.rpc {}
		// biome-ignore lint/suspicious/noEmptyInterface: declaration merging bridge
		interface sse extends ServicesUI.sse {}
	}
}
