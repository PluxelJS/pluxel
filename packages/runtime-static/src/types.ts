import type { Context as CoreContext, CommitSummary, PluginConstructor } from '@pluxel/core'
import type { Context } from '@pluxel/runtime'
import type { StaticRuntimeRegisteredServices as RuntimeStaticRegisteredServices } from '@pluxel/runtime/register/static'
import type { RuntimeStateStoreConfig } from '@pluxel/runtime/runtime-state'

export type StaticRuntimeRegisteredServices = RuntimeStaticRegisteredServices

export type StaticRuntimeConfigServiceConfig = {
	mode?: 'file' | 'memory' | 'readonly'
	path?: string
	snapshot?: Partial<{
		plugins: Record<string, Record<string, unknown>>
	}>
}

export type StaticRuntimePersistenceCapability = 'durable' | 'ephemeral' | 'readonly'

export type StaticRuntimePersistenceEntry = {
	key: string
	kind: 'file' | 'directory'
	size?: number
	updatedAt?: Date
}

export type StaticRuntimePersistenceRequirement = {
	durable?: boolean
	writable?: boolean
}

export type StaticRuntimePersistenceNamespace = {
	get(key: string): Promise<Uint8Array | undefined>
	getText(key: string): Promise<string | undefined>
	put(key: string, value: Uint8Array | string, options?: { atomic?: boolean }): Promise<void>
	delete(key: string): Promise<void>
	list(prefix?: string): AsyncIterable<StaticRuntimePersistenceEntry>
	stat(key: string): Promise<StaticRuntimePersistenceEntry | undefined>
}

export type StaticRuntimePersistenceBackend = {
	capability: StaticRuntimePersistenceCapability
	namespace(name: string): StaticRuntimePersistenceNamespace
	preflight?(requirement?: StaticRuntimePersistenceRequirement): Promise<void>
}

export type StaticRuntimePersistenceConfig = {
	mode?: 'file' | 'memory' | 'readonly'
	backend?: StaticRuntimePersistenceBackend
}

export type StaticRuntimePluginDataConfig = {
	dir?: string
	enabled?: boolean
}

export type StaticRuntimeHttpHandler = (
	req: Request,
	env?: unknown,
	ctx?: unknown,
) => Response | Promise<Response>

export type StaticRuntimeUiAssetStrategy = 'hmr-server' | 'static-built' | 'disabled'

export type StaticRuntimeHttpConfig = {
	management?: boolean
	graphql?: boolean
	controlPlane?: {
		web?: boolean
		rpc?: boolean
		sse?: boolean
	}
	uiAssets?: StaticRuntimeUiAssetStrategy
	uiPublicDir?: string
}

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
	 * Additional runtime context config. `configService` is still owned by this route
	 * option and overrides `context.configService`.
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
