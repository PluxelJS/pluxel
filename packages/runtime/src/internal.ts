// Type-only re-exports keep the source entry's Context shape complete without installing services.
export type { RuntimeHostConfig } from './context/runtime-contract'

export * from './shared'
export * from './plugin-catalog'
export * from './runtime-state'
export * from './internal/reconciliation'
export { requireRuntimeStateStore } from './internal/runtime-state'
export { requireRuntimeHttpService } from './context/runtime-http-capability'
export type {
	ElysiaCarrierMetadata,
	ElysiaCarrierRequestAddress,
	ElysiaApplicationCarrier,
	ElysiaWebSocketUpgrade,
} from '@pluxel/services/http'
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
export { createNodeWorkspaceFsBackend } from '@pluxel/services/internal/workspace-fs'
export type { NodeWorkspaceFs, WorkspaceFsBackend } from '@pluxel/services/internal/workspace-fs'
export {
	isWorkbenchEnabled,
	matchesWorkbenchUiBasePath,
	resolveWorkbenchUiBasePath,
} from './workbench-config'
export { isRuntimeManagementEnabled, resolveRuntimePlanePlan } from './runtime-plane'
export { mergeConfigRecords, withPluginConfigEnvironment } from './services/config-environment'
export { readHostProduct, sameProduct } from './product-internal'
export {
	subscribeDatabaseHandle,
	databaseHandleOwnsTables,
} from '@pluxel/services/internal/database'
export { createRuntimeRootContext, type RuntimeRootContextOptions } from './context/runtime-plan'
export {
	readDatabaseDefinition,
	type DatabaseArtifact,
	type DatabaseMigration,
} from '@pluxel/services/internal/database'
export {
	RUNTIME_INTERNAL_API_BASE,
	UI_PUBLIC_ASSET_BASE,
	UI_PUBLIC_BASE,
} from '@pluxel/management/internal/web/paths'
export { RUNTIME_SESSION_PATH } from '@pluxel/management/internal/web/session/protocol'

// Host/toolchain-only federation inventory (kept out of the Plugin author surface).
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
} from '@pluxel/logging/internal'

export { PluginRecentUpdateTracker } from '@pluxel/host/internal'

export { createDevConsoleScope, type DevConsoleScope } from '@pluxel/host-dev/internal/dev/console'

export { resolvePackagedNodeModule } from './runtime/packaged-node-artifact'
