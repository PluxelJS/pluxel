// plugins/index.ts
// Barrel exports for the core plugin system.
//
// Folder layout:
// - PluginService / PluginActor / LifecycleManager / fork: "main" runtime surface
// - internal/: definition-time and infrastructure (BasePlugin, decorators, DI definitions, helpers)

export * from './BaseFeature'
export * from './ConfigHost'
export * from './FeatureHost'
export * from './fork'
export * from './internal/BasePlugin'
export * from './internal/decoratorRuntime'
export * from './internal/PluginDecorator'
export * from './internal/PluginDefinitions'
export * from './internal/types'
export * from './LifecycleManager'
export * from './PluginActor'
export * from './PluginService'
