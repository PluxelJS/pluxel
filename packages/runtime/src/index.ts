import './runtime/register/static'
import { setPluxelRuntime } from '@pluxel/core'

setPluxelRuntime('core')

export { EvtChannel } from '@pluxel/core/services'
export * from './base'
export { f, v } from './config'
export {
	PersistenceError,
	createMemoryPersistenceBackend,
	createReadonlyPersistenceBackend,
	createWorkspacePersistenceBackend,
	type PersistenceBackend,
	type PersistenceCapability,
	type PersistenceEntry,
	type PersistenceMode,
	type PersistenceNamespace,
	type PersistenceRequirement,
	type PersistenceServiceConfig,
	type WorkspacePersistenceBackendFs,
	type WorkspacePersistenceBackendOptions,
} from './services/persistence/PersistenceService'
export type { ConfigServiceConfig } from './services/ConfigService'
export type { PluginDataServiceConfig } from './services/PluginDataService'
export {
	PLUGIN_HTTP_BASE,
	type ElysiaRouteHandle,
	type HttpServiceConfig,
	type HttpHandler,
	type UiAssetStrategy,
} from './services/http/HttpService'
export {
	createElysiaApp,
	type AnyElysiaApp,
	type CreateElysiaAppOptions,
} from './services/http/elysia'
export { createPluginGatedRouter, type PluginGatedModuleDef } from './services/http/elysia-routing'
export { createInternalGraphQLSchemaSDL } from './services/http/internalGraphqlSchema'
export {
	setPluginEnabled,
} from './runtime-state'
export {
	getPluginRoutingSnapshot,
	type PluginRoutingSnapshot,
	type RouteId,
} from './services/routing/pluginGatedRoutes'
export type { StaticRuntimeRegisteredServices } from './runtime/register/static'
