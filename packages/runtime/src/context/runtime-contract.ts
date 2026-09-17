import '@pluxel/management/service'
import '@pluxel/management/access'
import '@pluxel/services/http'
import '@pluxel/services/node'
import '@pluxel/services/workers'
import '@pluxel/services/persistence'
import '@pluxel/services/vault'
import type { Context as CoreContext, CoreHostConfig } from '@pluxel/core'
import type { WorkersConfig } from '@pluxel/services/workers'
import type { ConfigServiceConfig } from '../services/ConfigService'
import type { DatabaseConfig } from '../services/database-config'
import type { RuntimeStateStoreConfig } from '../services/RuntimeStateStore'
import type { RuntimeHttpAssetConfig } from '../services/http/HttpService'
import type { PersistenceServiceConfig } from '@pluxel/services/internal/persistence'
import type { VaultServiceConfig } from '@pluxel/services/internal/vault-types'
import '@pluxel/workbench/service'
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
	/** Explicitly installs headless management. Workbench also installs management when enabled. */
	management?: true
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
	interface Context {}
	interface RootContext {}
}
