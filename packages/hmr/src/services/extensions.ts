/**
 * RPC 扩展接口（插件通过 declaration merging 扩展）
 *
 * 插件侧推荐写：
 * ```ts
 * declare module '@pluxel/hmr/services' {
 *   interface RpcExtensions {
 *     MyPlugin: MyPluginRpc
 *   }
 * }
 * ```
 */
// biome-ignore lint/suspicious/noEmptyInterface: 外部扩展
export interface RpcExtensions {}

/**
 * SSE 事件接口（插件通过 declaration merging 扩展）
 *
 * key 是 namespace，value 是 payload 的 union/shape。
 *
 * 插件侧推荐写：
 * ```ts
 * declare module '@pluxel/hmr/services' {
 *   interface SseEvents {
 *     MyPlugin: MyPluginSsePayload
 *   }
 * }
 * ```
 */
// biome-ignore lint/suspicious/noEmptyInterface: 外部扩展
export interface SseEvents {}
