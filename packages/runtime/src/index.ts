import './context-augment'
import './events'
import './services'
import './services/debug'

export * from '@pluxel/core'
export { Config, type ConfigSchemaMap } from './base'
export {
	defineWorkerTask,
	WorkerTaskError,
	type WorkerTaskDeclaration,
	type WorkerTaskHandler,
	type WorkerRunOptions,
	type WorkersConfig,
	type WorkerTaskErrorCode,
} from './node-artifact/worker-task'
export { defineNodeModule, type NodeModuleDeclaration } from './node-artifact/node-module'
export type { DatabaseConfig } from './services/DatabaseService'
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
export type { CommandCatalogSnapshot } from './services/CommandsService'
export {
	type AgentCommandCatalog,
	type AgentCommandCatalogSnapshot,
	type AgentToolAssignment,
	type AgentToolsAdminSnapshot,
	type AgentToolsPolicy,
	type AgentToolsPolicyInput,
	type CommandInventoryItem,
	type CommandToolset,
} from './agent-tools'
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
export {
	getPluginRoutingSnapshot,
	type PluginRoutingSnapshot,
	type RouteId,
} from './services/routing/pluginGatedRoutes'
export type { WorkbenchConfig, WorkbenchPluginGroupConfig } from './workbench-config'
