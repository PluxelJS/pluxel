export type { HmrRuntimeHandles } from './runtime/hmr-handles'
export {
	clearHmrRuntimeHandles,
	getHmrRuntimeHandles,
	setHmrRuntimeHandles,
} from './runtime/hmr-handles'

export type { RuntimeModuleAdapter, RuntimeModuleCacheEntry } from './runtime/module-runtime'
export {
	clearRuntimeModuleAdapter,
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
export {
	findRuntimeModuleId,
	resolveModuleIdBaseDir,
	resolveModuleIdPath,
} from './runtime/module-id'

// HMR-only helpers used by @pluxel/runtime-dynamic/hmr (kept out of the public `services` surface).
export type { ExtensionModuleStore } from './services/plugin-interaction/ExtensionService'
export { createCompiledExtensionModule } from './services/plugin-interaction/ExtensionService'
