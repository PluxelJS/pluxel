type ServicesRpc = import('./plugin-interaction').UI.rpc
type ServicesSse = import('./plugin-interaction').UI.sse

/**
 * Bridge: 让 `@pluxel/hmr-web` 的 `UI.rpc`/`UI.sse` 自动包含
 * `@pluxel/hmr/services` 的扩展（插件只依赖 @pluxel/hmr 即可）。
 *
 * 目标：插件只需要依赖 `@pluxel/hmr`，不需要直接依赖 `@pluxel/hmr-web`。
 */
declare module '@pluxel/hmr-web' {
	namespace UI {
		interface rpc extends ServicesRpc {}
		interface sse extends ServicesSse {}
	}
}

// Keep a tiny runtime export so bundlers emit this module when imported for side effects.
export const __hmrWebAugment = 0 as const
