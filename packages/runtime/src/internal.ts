export { runtimeDevCapabilities, runtimeModuleRuntime } from './runtime/capabilities'
export type {
	RuntimeDevCapabilities,
	RuntimeModuleCacheEntry,
	RuntimeModuleRuntime,
	RuntimeWorkerWatchOptions,
} from './runtime/capabilities'

export type { RuntimeStorageLayout, RuntimeStoragePaths } from './runtime/paths'
export { resolveRuntimeStoragePaths } from './runtime/paths'
export {
	findRuntimeModuleId,
	resolveModuleIdBaseDir,
	resolveModuleIdPath,
} from './runtime/module-id'
export { createNodeWorkspaceFsBackend } from './runtime/workspace-fs'
export type { NodeWorkspaceFs, WorkspaceFsBackend } from './runtime/workspace-fs'
export { isManagementEnabled, managementAdminAccess } from './management-config'
export {
	requireManagementBackend,
	withManagementPluginContext,
} from './services/management/ManagementService'

// HMR-only helpers used by @pluxel/runtime-dynamic/hmr (kept out of the public `services` surface).
export type { ManagementArtifactStore } from './services/management/ManagementArtifactService'
export { createCompiledManagementArtifact } from './services/management/ManagementArtifactService'
