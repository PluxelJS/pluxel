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
} from './services/http/elysia-application-carrier'
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
export { isRuntimeManagementEnabled, resolveRuntimePlanePlan } from './runtime-plane'
export { mergeConfigRecords, withPluginConfigEnvironment } from './services/config-environment'
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
export {
	createRuntimeRootContext,
	prepareRuntimeRootContext,
	type RuntimeRootContextOptions,
} from './context/runtime-plan'
export {
	readDatabaseDefinition,
	type DatabaseArtifact,
	type DatabaseMigration,
} from './database-internal'
export {
	readWorkbenchDefinition,
	readWorkbenchContentSlot,
	readWorkbenchDescriptor,
	readWorkbenchMarkdownDocument,
	readWorkbenchRendererEntry,
} from './workbench/definition'
export type {
	WorkbenchDefinitionMetadata,
	WorkbenchContentActionMetadata,
	WorkbenchContentDataMetadata,
	WorkbenchContentSlotMetadata,
	WorkbenchDescriptorMetadata,
	WorkbenchMarkdownDocumentMetadata,
	WorkbenchRendererEntryMetadata,
} from './workbench/definition'
export { resolveDevWorkbenchClientEntryUrl } from './server/assets'
export {
	RUNTIME_INTERNAL_API_BASE,
	UI_PUBLIC_ASSET_BASE,
	UI_PUBLIC_BASE,
	runtimeWorkbenchFederationArtifactBasePath,
	runtimeWorkbenchFederationArtifactPath,
} from './web/paths'
export { RUNTIME_SESSION_PATH } from './web/session/protocol'

// Host/toolchain-only federation inventory (kept out of the Plugin author surface).
export {
	WorkbenchArtifactService,
	type WorkbenchArtifactCandidate,
	type WorkbenchArtifactCommit,
	type WorkbenchArtifactEntry,
	type WorkbenchArtifactFile,
	type WorkbenchArtifactLookup,
	type WorkbenchArtifactRevision,
	type WorkbenchResolvedArtifactEntry,
} from './services/workbench/WorkbenchArtifactService'
export {
	WorkbenchArtifactCoordinator,
	type WorkbenchArtifactBatchCandidate,
	type WorkbenchArtifactBatchCommit,
} from './services/workbench/WorkbenchArtifactCoordinator'
export {
	WorkbenchContentArtifactService,
	type WorkbenchContentArtifactCandidate,
	type WorkbenchContentArtifactCommit,
	type WorkbenchContentArtifactEntry,
	type WorkbenchContentArtifactLookup,
	type WorkbenchContentArtifactRevision,
	type WorkbenchResolvedContentArtifact,
} from './services/workbench/WorkbenchContentArtifactService'
export {
	WorkbenchProducerStatusService,
	type WorkbenchProducerBuildIdentity,
	type WorkbenchProducerStatus,
	type WorkbenchProducerStatusLookup,
	type WorkbenchProducerStatusReporter,
} from './services/workbench/WorkbenchProducerStatusService'
export {
	loadPackagedWorkbenchDeployment,
	resolvePackagedNodeModule,
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
