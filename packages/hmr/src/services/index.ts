// 再导出 API（这里不会重复注册，因为 Injectable 内部有跳过逻辑）
export * from '@pluxel/core/services'
export * from '../logger/LogtapeLoggerService'
export * from '../logger/sink'
export type { ConfigShape } from './ConfigService'
export { ConfigService as HmrConfigService } from './ConfigService'
export * from './debug'
export * from './http'
export * from './routing/pluginGatedRoutes'
export * from './PluginDataService'
// Plugin extensibility surface (types only)
export type { UI } from './plugin-interaction'
export * from './plugin-interaction'
export * from './runtime/hmr/HMRService'
export * from './runtime/loader/LoaderService'
export * from './runtime/package/PackageService'
export * from './runtime/package/specifiers'
export * from './runtime/scan/ScanService'
export * from './runtime-compile'

// Ensure consumers of `@pluxel/hmr/services` see HMR-specific `Context.Config` keys.
import '../context-augment'
// Ensure module augmentations are part of the program when importing `@pluxel/hmr/services`.
import '../events'
