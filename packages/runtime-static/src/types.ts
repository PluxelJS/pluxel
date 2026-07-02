import type { Context as CoreContext, CommitSummary, PluginConstructor } from '@pluxel/core'
import type {
	ConfigServiceConfig,
	Context,
	HttpHandler,
	HttpServiceConfig,
	PersistenceBackend,
	PersistenceCapability,
	PersistenceEntry,
	PersistenceNamespace,
	PersistenceRequirement,
	PersistenceServiceConfig,
	PluginDataServiceConfig,
} from '@pluxel/runtime'
import type { StaticRuntimeRegisteredServices as RuntimeStaticRegisteredServices } from '@pluxel/runtime/register/static'
import type { RuntimeStateStoreConfig } from '@pluxel/runtime/runtime-state'

export type StaticRuntimeRegisteredServices = RuntimeStaticRegisteredServices

export type StaticRuntimeConfigServiceConfig = ConfigServiceConfig
export type StaticRuntimePersistenceCapability = PersistenceCapability
export type StaticRuntimePersistenceEntry = PersistenceEntry
export type StaticRuntimePersistenceRequirement = PersistenceRequirement
export type StaticRuntimePersistenceNamespace = PersistenceNamespace
export type StaticRuntimePersistenceBackend = PersistenceBackend
export type StaticRuntimePersistenceConfig = PersistenceServiceConfig
export type StaticRuntimePluginDataConfig = PluginDataServiceConfig
export type StaticRuntimeHttpHandler = HttpHandler
export type StaticRuntimeHttpConfig = HttpServiceConfig

export type StaticRuntimeDefinition = {
	/**
	 * Stable runtime id used only for diagnostics, storage labels, and read models.
	 */
	name: string
	/**
	 * Fixed plugin catalog. Plugin names are read from @Plugin metadata.
	 */
	plugins: readonly PluginConstructor[]
}

export type StaticRuntimeConfig = StaticRuntimeDefinition & StaticRuntimeHostOptions

export type StaticRuntimeHostOptions = {
	/**
	 * Runtime config source used for plugin enablement and plugin config records.
	 *
	 * @default JSON config stored in the configured persistence backend.
	 */
	configService?: StaticRuntimeConfigServiceConfig
	/**
	 * Runtime control-plane state source used for plugin enablement, fork metadata,
	 * dependency overrides, and built-in catalog state.
	 *
	 * @default JSON runtime state stored in the configured persistence backend.
	 */
	runtimeState?: RuntimeStateStoreConfig
	/**
	 * Shared runtime persistence backend used by config/state/plugin data/logger/vault.
	 *
	 * @default In-memory persistence. Durable/file-backed static hosts must pass a backend.
	 */
	persistence?: StaticRuntimePersistenceConfig
	/**
	 * Plugin-owned runtime data storage.
	 *
	 * @default Uses the shared persistence backend under the plugin-data namespace.
	 */
	pluginData?: StaticRuntimePluginDataConfig
	/**
	 * HTTP runtime settings. Static direct hosts default to a production API surface with
	 * management UI/RPC/SSE disabled unless explicitly enabled here.
	 */
	http?: StaticRuntimeHttpConfig
	/**
	 * Runtime logger settings.
	 */
	logger?: CoreContext.Config['logger']
	/**
	 * Runtime profile used for config/state storage labels and diagnostics.
	 */
	profile?: CoreContext.Config['profile']
	/**
	 * Additional low-level runtime context config. Prefer top-level static runtime config
	 * fields for common runtime options.
	 *
	 * @default {}
	 */
	context?: CoreContext.Config
}

export type StaticRuntimeHost = {
	readonly ctx: Context
	readonly options: StaticRuntimeHostOptions
	readonly hmr: StaticRuntimeHmrController
	readonly definition: StaticRuntimeDefinition
	start(): Promise<StaticRuntimeStartupReport>
	stop(): Promise<void>
	describeCatalog(): StaticRuntimeCatalogSnapshot
	lastReport(): StaticRuntimeStartupReport | undefined
}

export type StaticRuntime = {
	readonly ctx: Context
	fetch: StaticRuntimeHttpHandler
	start(): Promise<StaticRuntimeStartupReport>
	stop(): Promise<void>
}

export type StaticRuntimeHmrController = {
	reload(definition: StaticRuntimeDefinition): Promise<StaticRuntimeHmrReport>
}

export type StaticRuntimePluginStatus =
	| 'started'
	| 'disabled'
	| 'config-invalid'
	| 'dependency-missing'
	| 'dependency-failed'
	| 'start-failed'
	| 'unknown-config-entry'
	| 'catalog-drift'

export type StaticRuntimeReportEntry = {
	readonly name: string
	readonly status: StaticRuntimePluginStatus
	readonly message?: string
}

export type StaticRuntimeStartupReport = {
	readonly runtime: string
	readonly entries: readonly StaticRuntimeReportEntry[]
	readonly commit?: CommitSummary
}

export type StaticRuntimeHmrReport = StaticRuntimeStartupReport & {
	readonly added: readonly string[]
	readonly removed: readonly string[]
	readonly replaced: readonly string[]
}

export type StaticRuntimeCatalogEntry = {
	readonly name: string
	readonly plugin: PluginConstructor
}

export type StaticRuntimeCatalogSnapshot = {
	readonly runtime: string
	readonly plugins: readonly StaticRuntimeCatalogEntry[]
}
