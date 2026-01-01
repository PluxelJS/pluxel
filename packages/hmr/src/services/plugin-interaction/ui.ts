/**
 * UI extensibility surface (plugins augment this via declaration merging).
 *
 * This is the single source of truth for UI-facing RPC/SSE types.
 *
 * @example
 * declare module '@pluxel/hmr/services' {
 *   namespace UI {
 *     interface rpc {
 *       MyPlugin: MyPluginRpc
 *     }
 *
 *     interface sse {
 *       MyPlugin: MyPluginSsePayload
 *     }
 *   }
 * }
 */
export declare namespace UI {
	// biome-ignore lint/suspicious/noEmptyInterface: declaration merging target
	interface rpc {}
	// biome-ignore lint/suspicious/noEmptyInterface: declaration merging target
	interface sse {}
}

