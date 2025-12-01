import type { ExtensionContext, PluginUIModule } from '@pluxel/components'
export type { ExtensionContext }
/**
 * Helper to define a plugin UI module with full type inference.
 *
 * 使用者可以（推荐从 `@pluxel/components/extension/define` 导入）：
 * ```ts
 * import { definePluginUIModule } from '@pluxel/components/extension/define'
 *
 * export default definePluginUIModule({
 *   extensions: [...],
 * })
 * ```
 * 而无需显式为 extensions/routes/setup 注明类型。
 */
export function definePluginUIModule<T extends PluginUIModule>(module: T): T {
	return module
}
