// Type-only re-exports keep the source entry's Context shape complete without installing services.
export type { RuntimeHostConfig } from './context/runtime-contract'

export * from './shared'
export * from './plugin-catalog'
export * from './runtime-state'
export * from './internal/reconciliation'
export { requireRuntimeStateStore } from './internal/runtime-state'
export { createPluginGatedRouter, type PluginGatedModuleDef } from './services/http/elysia-routing'
export {
	getPluginRoutingSnapshot,
	type PluginRoutingSnapshot,
	type RouteId,
} from './services/routing/pluginGatedRoutes'
export {
	installRuntimeRouteCapabilities,
	readRuntimeRouteCapabilities,
	requireRouteCapability,
	runtimeModuleRuntime,
} from './runtime/capabilities'
export type { RuntimeRouteCapabilities } from './runtime/capabilities'
export type { RuntimeModuleCacheEntry, RuntimeModuleRuntime } from './runtime/capabilities'

export type { RuntimeStorageLayout, RuntimeStoragePaths } from './runtime/paths'
export { resolveRuntimeStoragePaths } from './runtime/paths'
export { resolveModuleIdBaseDir, resolveModuleIdPath } from './runtime/module-id'
export { createNodeWorkspaceFsBackend } from './runtime/workspace-fs'
export type { NodeWorkspaceFs, WorkspaceFsBackend } from './runtime/workspace-fs'
export {
	isWorkbenchEnabled,
	matchesWorkbenchUiBasePath,
	resolveWorkbenchUiBasePath,
} from './workbench-config'
export { isRuntimeManagementEnabled, resolveRuntimePlanePlan } from './management-config'
export { withPluginConfigEnvironment } from './services/config-environment'
export { CommandsService } from './services/CommandsService'
export {
	NodeModuleService,
	type NodeModuleSourceBinder,
	type NodeModuleSourceSubscription,
} from './node-artifact/NodeModuleService'
export { WorkerTaskService } from './node-artifact/WorkerTaskService'
export { readNodeModuleDeclaration } from './node-artifact/node-module'
export { readHostProduct, sameProduct } from './product-internal'
export { subscribeDatabaseHandle, databaseHandleOwnsTables } from './services/DatabaseService'
export { createRuntimeRootContext, type RuntimeRootContextOptions } from './context/runtime-plan'
export { prepareContextCapabilities } from '@pluxel/core/internal'
export {
	readDatabaseDefinition,
	type DatabaseArtifact,
	type DatabaseMigration,
} from './database-internal'
export { readWorkbenchUiEntry } from './workbench/ui-entry'
export { resolveDevWorkbenchClientEntryUrl } from './server/assets'
export {
	RUNTIME_INTERNAL_API_BASE,
	UI_PUBLIC_BASE,
	runtimeWorkbenchArtifactBasePath,
} from './web/paths'

// HMR-only helpers used by @pluxel/runtime-dynamic/hmr (kept out of the public `services` surface).
export type { WorkbenchArtifactService } from './services/workbench/WorkbenchArtifactService'
export { createCompiledWorkbenchArtifact } from './services/workbench/WorkbenchArtifactService'
export {
	resolvePackagedNodeModule,
	resolvePackagedWorkbenchManifest,
} from './services/workbench/packaged-artifact'
export {
	createWorkbenchBackend,
	requireWorkbench,
	type WorkbenchBackendFactory,
	type WorkbenchInstallOptions,
} from './services/workbench'
export { createContextPluginLogPolicyStore } from './logger/levels'
export {
	bindContextRuntimeLogging,
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
