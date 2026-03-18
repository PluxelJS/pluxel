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

// Dev-only helpers used by @pluxel/hmr (kept out of the public `services` surface).
export type {
	ExtensionCompilerApi,
	ExtensionModuleStore,
} from './services/plugin-interaction/ExtensionService'
export {
	normalizeJsxRuntime,
	looksLikeBrokenExtensionBundle,
	toBrowserBundleResolve,
	transformVendorImports,
} from './services/plugin-interaction/extensionBundleTransform'
