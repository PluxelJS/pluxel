export type { DevRuntimeHandles } from './runtime/dev-handles'
export {
	clearDevRuntimeHandles,
	getDevRuntimeHandles,
	setDevRuntimeHandles,
} from './runtime/dev-handles'

export type {
	RuntimeModuleAdapter,
	RuntimeModuleCacheEntry,
} from './runtime/module-runtime'
export {
	clearRuntimeModuleAdapter,
	createHmrModuleRuntimeAdapter,
	getRuntimeModuleAdapter,
	hasRuntimeModuleAdapter,
	setRuntimeModuleAdapter,
} from './runtime/module-runtime'

export type {
	MaterializeProfiledFileOptions,
	ResolvedProfiledPath,
	RuntimeStorageLayout,
	RuntimeStoragePaths,
} from './runtime/paths'
export {
	HOST_PROFILE_TOKEN,
	resolveProfiledPath,
	resolveRuntimeStoragePaths,
} from './runtime/paths'
export { resolveModuleIdBaseDir, resolveModuleIdPath } from './runtime/module-id'

// Dev-only helpers used by @pluxel/hmr (kept out of the public `services` surface).
export type { ExtensionModuleStore } from './services/plugin-interaction/ExtensionService'
export { createCompiledExtensionModule } from './services/plugin-interaction/ExtensionService'
