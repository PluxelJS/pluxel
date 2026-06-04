export { EvtChannel } from '@pluxel/core/services'
export {
	LogtapeLoggerService,
	type LogtapeLoggerServiceConfig,
} from './logger/LogtapeLoggerService'
export { createLogStoreSink, createRuntimeLogSink, type RuntimeLogSinkOptions } from './logger/sink'

export {
	ConfigService,
	type ConfigServiceConfig,
	type ConfigServiceMode,
	type ConfigShape,
} from './services/ConfigService'

export {
	getDebugLogger,
	isDebugTopicEnabled,
	resolveDebugTopics,
	type DebugTopic,
} from './services/debug'
export { bootstrapHostVault } from './services/security/bootstrap'
export {
	deleteLocalVerificationUser,
	describeLocalVerification,
	resetLocalVerification,
	setLocalVerificationMethod,
	setLocalVerificationMode,
	upsertLocalVerificationPasswordUser,
	type LocalVerificationSnapshot,
} from './services/security/local-admin'

export {
	FsError,
	FsService,
	createNodeFsServiceBackend,
	type FsServiceBackend,
	type FsServiceNodeBackendFs,
	type FsEntryType,
	type FsServiceConfig,
	type FsServiceMode,
	type FsServiceStats,
	type FsStat,
} from './services/fs/FsService'

export {
	HttpService,
	PLUGIN_HTTP_BASE,
	type ElysiaBoundaryBuilder,
	type ElysiaRouteHandle,
	type ElysiaRouteMountOptions,
	type HostHttpMountSpec,
	type HostHttpRouteOptions,
	type HttpBoundary,
	type HttpBoundaryHandle,
	type HttpHandler,
	type HttpServiceConfig,
	type PluginHttpMountOptions,
	type UiAssetStrategy,
} from './services/http/HttpService'
export {
	createElysiaApp,
	type AnyElysiaApp,
	type CreateElysiaAppOptions,
} from './services/http/elysia'
export { createPluginGatedRouter, type PluginGatedModuleDef } from './services/http/elysia-routing'
export {
	InternalApiValidationService,
	type InternalApiValidationContext,
	type InternalApiValidationResult,
	type InternalApiValidator,
} from './services/http/InternalApiValidationService'
export {
	InternalGraphQLService,
	type InternalGraphQLConfig,
} from './services/http/InternalGraphQLService'
export {
	createConnectFetchMiddleware,
	createNodeHttpHandler,
	sendWebResponse,
	toWebRequest,
	type ConnectMiddleware,
	type CreateConnectFetchMiddlewareOptions,
} from './services/http/node-adapters'

export { PluginDataService, type PluginDataServiceConfig } from './services/PluginDataService'

export {
	getPluginRoutingSnapshot,
	resolveIsPluginEnabled,
	type IsPluginEnabled,
	type PluginGatedDef,
	type PluginGatedOptions,
	type PluginGatedRouteMeta,
	type PluginId,
	type PluginRoutingSnapshot,
	type RouteId,
} from './services/routing/pluginGatedRoutes'

export { doc } from './services/plugin-interaction/doc'
export {
	OpsService,
	type RuntimeOpCatalogEntry,
	type RuntimeOpContext,
	type RuntimeOpContextInput,
	type RuntimeOperation,
	type RuntimeOpSource,
	type RuntimeOpCatalogOptions,
	type RuntimeOpsRegisterOptions,
	type RuntimeMcpToolDef,
} from './services/ops/OpsService'
export type {
	SignalDbCollectionHandle,
	SignalDbDocumentHandle,
	SignalDbCollectionOptions,
} from './services/plugin-interaction/SignalDbService'
export {
	OpsToolsetInputSchema,
	OpsToolsetSchema,
	type OpsToolset,
	type OpsToolsetInput,
	type OpsToolsetInputValue,
	type OpsToolsetOutput,
	type RuntimeOpToolsetManifest,
} from './services/ops/toolsets'
export type { ExtensionUiRpcMap } from './web/protocol'
export type { SseChannel } from './services/plugin-interaction/SseService'

export type {
	VaultAdminApi,
	VaultAdminState,
	VaultBlobHandle,
	VaultBlobsHandle,
	VaultCollectionHandle,
	VaultDocsHandle,
	VaultKeyPair,
	VaultKvHandle,
	VaultKvTransaction,
	VaultNamespace,
	VaultNamespaceTransaction,
	VaultNamespaceOptions,
	VaultNamespaceStats,
	VaultServiceConfig,
} from './services/vault/types'

export {
	EXTRA_BASE_PROVIDERS,
	EXTRA_BUILTINS_KNOWN,
	EXTRA_DEP_OVERRIDES,
	EXTRA_FORKS,
	RuntimePluginCatalogService,
	getRuntimePluginCatalog,
	type BaseProvidersExtra,
	type BuiltinsKnownExtra,
	type DepOverridesExtra,
	type ForksExtra,
	type RuntimePluginCatalog,
	type RuntimePluginDependencyInfo,
	type RuntimePluginLifecycleStage,
	type RuntimePluginSource,
	type RuntimePluginStatusOverview,
	type RuntimePluginStatusSnapshot,
} from './services/runtime/catalog/RuntimePluginCatalogService'
