export { runtimeDevCapabilities, runtimeModuleRuntime } from './runtime/capabilities'
export type {
	RuntimeDevCapabilities,
	RuntimeModuleCacheEntry,
	RuntimeModuleRuntime,
	RuntimeWorkerWatchOptions,
} from './runtime/capabilities'

export type {
	RuntimeStorageLayout,
	RuntimeStoragePaths,
} from './runtime/paths'
export {
	resolveRuntimeStoragePaths,
} from './runtime/paths'
export {
	findRuntimeModuleId,
	resolveModuleIdBaseDir,
	resolveModuleIdPath,
} from './runtime/module-id'
export { createNodeWorkspaceFsBackend } from './runtime/workspace-fs'
export type { NodeWorkspaceFs, WorkspaceFsBackend } from './runtime/workspace-fs'

// HMR-only helpers used by @pluxel/runtime-dynamic/hmr (kept out of the public `services` surface).
export type { ExtensionModuleStore } from './services/plugin-interaction/ExtensionService'
export { createCompiledExtensionModule } from './services/plugin-interaction/ExtensionService'
