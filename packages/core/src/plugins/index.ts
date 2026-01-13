// plugins/index.ts
// Barrel exports for the core plugin system.
//
// Folder layout:
// - PluginService / PluginActor / LifecycleManager / fork: "main" runtime surface
// - internal/: definition-time and infrastructure (BasePlugin, decorators, DI definitions, helpers)

export * from './PluginService'
export * from './PluginActor'
export * from './LifecycleManager'
export * from './fork'

export * from './internal/BasePlugin'
export * from './internal/PluginDefinitions'
export * from './internal/PluginDecorator'
export * from './internal/decoratorRuntime'
export * from './internal/types'
