import './context-augment'
import './events'
import './services'
import './services/debug'

export * from '@pluxel/core'
export { Config, type ConfigSchemaMap } from './base'
export { f, v } from './config'
export type { RuntimeEvents } from './events'
export {
	PersistenceError,
	createMemoryPersistenceBackend,
	createNodePersistenceBackend,
	createReadonlyPersistenceBackend,
	createWorkspacePersistenceBackend,
	type MemoryPersistenceBackendOptions,
	type PersistenceBackend,
	type PersistenceCapability,
	type PersistenceEntry,
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
} from './services/http/HttpService'
export {
	createElysiaApp,
	type AnyElysiaApp,
	type CreateElysiaAppOptions,
} from './services/http/elysia'
export { createPluginGatedRouter, type PluginGatedModuleDef } from './services/http/elysia-routing'
export { createInternalGraphQLSchemaSDL } from './services/http/internalGraphqlSchema'
export { setPluginEnabled } from './runtime-state'
export {
	getPluginRoutingSnapshot,
	type PluginRoutingSnapshot,
	type RouteId,
} from './services/routing/pluginGatedRoutes'
export type { WorkbenchConfig } from './workbench-config'
