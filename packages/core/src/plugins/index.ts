// plugins/index.ts
// Barrel exports for the core plugin system.
//
// Folder layout:
// - runtime/: orchestrator and commit scheduling
// - decorators/: @Plugin/@Config metadata and decorator runtime
// - composition/: BasePlugin + FeatureHost + ConfigHost
// - types.ts: shared plugin type aliases

export * from './composition/BaseFeature'
export * from './composition/ConfigHost'
export * from './composition/cfg'
export * from './composition/FeatureHost'
export * from './composition/BasePlugin'
export * from './types'
export * from './decorators/PluginDecorator'
export * from './decorators/decoratorRuntime'
export * from './runtime/PluginDefinitions'
export * from './runtime/fork'
export * from './runtime/identity'
export * from './runtime/pluginId'
export * from './runtime/LifecycleManager'
export * from './runtime/PluginActor'
export * from './runtime/PluginService'
