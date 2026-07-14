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
export { isWorkbenchEnabled, workbenchAdminAccess } from './workbench-config'
export {
	requireWorkbenchBackend,
	withWorkbenchPluginContext,
} from './services/workbench/WorkbenchService'

// HMR-only helpers used by @pluxel/runtime-dynamic/hmr (kept out of the public `services` surface).
export type { WorkbenchArtifactStore } from './services/workbench/WorkbenchArtifactService'
export { createCompiledWorkbenchArtifact } from './services/workbench/WorkbenchArtifactService'
export { installWorkbench, requireWorkbench } from './services/workbench'
