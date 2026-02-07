// 再导出 API（这里不会重复注册，因为 Injectable 内部有跳过逻辑）
export * from '@pluxel/core/services'
export * from '../logger/LogtapeLoggerService'
export * from '../logger/sink'
export * from './ConfigService'
export * from './debug'
export * from './hono/AuthGuardService'
export * from './hono/index'
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

// Ensure module augmentations are part of the program when importing `@pluxel/hmr/services`.
import '../events'
import './augment-hmr-web'
