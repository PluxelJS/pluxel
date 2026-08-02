export * from './shared'
export * from './plugin-catalog'
export * from './runtime-state'
export type * from './web/protocol'
export { runtimeModuleRuntime } from './runtime/capabilities'
export type { RuntimeModuleCacheEntry, RuntimeModuleRuntime } from './runtime/capabilities'

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
export { withWorkbenchPluginContext } from './services/workbench/WorkbenchService'
export { CommandsService, withCommandsPluginContext } from './services/CommandsService'
export {
	NodeModuleService,
	withNodeModulePluginContext,
	type NodeModuleSourceBinder,
	type NodeModuleSourceSubscription,
} from './services/NodeModuleService'
export { readNodeModuleDeclaration } from './node-module'
export { readHostProduct, sameProduct } from './product-internal'
export {
	withDatabasePluginContext,
	subscribeDatabaseHandle,
	databaseHandleOwnsTables,
} from './services/DatabaseService'
export {
	readDatabaseDefinition,
	type DatabaseArtifact,
	type DatabaseMigration,
} from './database-internal'
export { readWorkbenchUiEntry } from './workbench/ui-entry'
export { resolveDevWorkbenchClientEntryUrl } from './server/assets'

// HMR-only helpers used by @pluxel/runtime-dynamic/hmr (kept out of the public `services` surface).
export type { WorkbenchArtifactService } from './services/workbench/WorkbenchArtifactService'
export { createCompiledWorkbenchArtifact } from './services/workbench/WorkbenchArtifactService'
export {
	resolvePackagedNodeModule,
	resolvePackagedWorkbenchManifest,
} from './services/workbench/packaged-artifact'
export {
	installWorkbench,
	requireWorkbench,
	type WorkbenchInstallOptions,
} from './services/workbench'
export { createContextPluginLogPolicyStore } from './logger/levels'
export {
	createRuntimeLogging,
	getActiveRuntimeLogging,
	requireActiveRuntimeLogging,
	requireContextRuntimeLogging,
	type ResolvedRuntimeLoggingPlan,
	type RuntimeConsoleSinkInput,
	type RuntimeCustomSinkInput,
	type RuntimeFileSinkInput,
	type RuntimeLogging,
	type RuntimeLoggingDescription,
	type RuntimeLoggingInput,
	type RuntimeLoggingRootInput,
	type RuntimeLoggingRouteBinding,
	type RuntimeLoggingSinkInput,
	type RuntimeLoggingState,
	type RuntimeStoreSinkInput,
} from './logger/logging'
