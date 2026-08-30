import type { Context as CoreContext, CoreHostConfig } from '@pluxel/core'
import type { NodeModuleService } from '../node-artifact/NodeModuleService'
import type { WorkersConfig } from '../node-artifact/worker-task'
import type { WorkerTaskService } from '../node-artifact/WorkerTaskService'
import type { CommandsService } from '../services/CommandsService'
import type { ConfigServiceConfig } from '../services/ConfigService'
import type { DatabaseConfig, DatabaseService } from '../services/DatabaseService'
import type { RuntimeStateStoreConfig } from '../services/RuntimeStateStore'
import type { RuntimeManagementService } from '../services/RuntimeManagementService'
import type { AdminAccessService } from '../services/admin-access/AdminAccessService'
import type { ManagementAccessService } from '../services/admin-access/ManagementAccessService'
import type { AgentToolsService } from '../services/commands/AgentToolsService'
import type { RuntimeHttpAssetConfig } from '../services/http/HttpService'
import type { Elysia } from 'elysia'
import type { InternalApiValidationService } from '../services/http/InternalApiValidationService'
import type {
	PersistenceService,
	PersistenceServiceConfig,
} from '../services/persistence/PersistenceService'
import type { VaultServiceConfig, VaultStorageApi } from '../services/vault/types'
import type { VaultAdminService } from '../services/vault/VaultService'
import type { WorkbenchService } from '../services/workbench/WorkbenchService'
import type { PluginCatalogLayoutService } from '../services/management/PluginCatalogLayoutService'
import type { ManagementConfig } from '../management-config'
import type { WorkbenchConfig } from '../workbench-config'

/** Host-owned inputs resolved into one immutable Runtime Context plan. */
export interface RuntimeHostConfig extends CoreHostConfig {
	configService?: ConfigServiceConfig
	runtimeState?: RuntimeStateStoreConfig
	persistence?: PersistenceServiceConfig
	database?: DatabaseConfig
	workers?: WorkersConfig
	/** @internal Workbench distribution asset wiring supplied by runtime launchers. */
	http?: RuntimeHttpAssetConfig
	/**
	 * Optional management plane. Object presence enables headless management;
	 * Workbench also enables management when this field is omitted.
	 */
	management?: ManagementConfig
	workbench?: WorkbenchConfig
	/** Runtime debug topics enabled for this host. */
	debug?: readonly string[]
	/** Explicitly enables the encrypted Vault. Omitted or `false` has zero backend cost. */
	vault?: false | VaultServiceConfig
	/** @internal Deployment-owned root containing assembled Workbench artifacts. */
	workbenchArtifactRoot?: string
	/** @internal Deployment root containing frozen Node module artifacts. */
	nodeModuleArtifactRoot?: string
	/** @internal Dynamic hosts resolve Node module artifacts from plugin packages. */
	nodeModuleArtifactResolver?: (
		root: CoreContext,
		owner: import('@pluxel/core').PluginNodeAddress,
		artifactKey: string,
	) => string | null | Promise<string | null>
}

declare module '@pluxel/core' {
	interface PluginContext {
		/** The native Elysia 2 application shared by one Plugin generation and all of its Parts. */
		readonly elysia: Elysia
	}
	interface Context {
		readonly commands: CommandsService
		readonly database: DatabaseService
		/** Present only when the host installed the optional Workbench Plane. */
		readonly workbench?: WorkbenchService
		readonly nodeModules: NodeModuleService
		readonly workers: WorkerTaskService
		/** Present only with Management; Plugins use it to provide remote admin authentication. */
		readonly managementAccess?: ManagementAccessService
		/** Present only when the host explicitly enables `vault` with a configuration object. */
		readonly vault?: VaultStorageApi
		/** @internal Runtime control-plane request validation. */
		readonly internalApiValidation?: InternalApiValidationService
	}
	interface RootContext {
		readonly persistence: PersistenceService
		/** Present only when the runtime management plane is enabled. */
		readonly adminAccess?: AdminAccessService
		/** @internal Present only when the runtime management plane is enabled. */
		readonly runtimeManagement?: RuntimeManagementService
		readonly agentTools: AgentToolsService
		/** @internal Management projection over the shared Plugin catalog. */
		readonly pluginCatalogLayout?: PluginCatalogLayoutService
		/** Present only when the host explicitly enables `vault` with a configuration object. */
		readonly vaultAdmin?: VaultAdminService
	}
}
