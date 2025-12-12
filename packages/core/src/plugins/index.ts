// plugins/index.ts
// Barrel exports for the core plugin system.
//
// Folder layout:
// - BasePlugin / PluginDecorator / PluginContainer / types: definition & DI pieces
// - lifecycle/: lifecycle FSM & selectors
// - service/: runtime commit orchestrator and its pure helpers

export * from './BasePlugin'
export * from './PluginContainer'
export * from './PluginDecorator'
export * from './service/PluginService'
export * from './lifecycle/pluginActor'
export * from './types'
