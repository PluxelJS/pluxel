/**
 * HMR protocol types (client/server shared).
 *
 * UI namespace stays here to keep module augmentation on `@pluxel/hmr-web` stable.
 */

/**
 * UI extensibility surface.
 *
 * @example
 * declare module '@pluxel/hmr-web' {
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
	interface rpc {}
	interface sse {}
}

export type * from './protocol-types'
export type HmrRpcApi = import('./protocol-types').HmrRpcApi<UI.rpc>
