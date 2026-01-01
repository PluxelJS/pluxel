// 再导出 API（这里不会重复注册，因为 Injectable 内部有跳过逻辑）
export * from '@pluxel/core/services'
export * from './ConfigService'
export * from './hmr/HMRService'
export * from './hono/AuthGuardService'
export * from './hono/index'
export * from './loader/LoaderService'
export * from './logger/PinoLoggerService'
export * from './market'
export * from './PluginDataService'
export * from './plugin-interaction'
export * from './runtime-compile'

// Plugin extensibility surface (types only)
export type { UI } from './plugin-interaction'

// Ensure module augmentations are part of the program when importing `@pluxel/hmr/services`.
import './augment-hmr-web'
