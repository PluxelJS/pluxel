import type {
	Context as CoreContext,
	CommitSummary,
	PluginConstructor,
	PluginDefinitionAddress,
	PluginEntryAddress,
	PluginNodeAddress,
} from '@pluxel/core'
import type {
	ConfigServiceConfig,
	Context,
	HttpHandler,
	HttpServiceConfig,
	PersistenceServiceConfig,
	DatabaseConfig,
	WorkbenchConfig,
} from '@pluxel/runtime'
import type { RuntimeStateStoreConfig } from '@pluxel/runtime/internal'
import type { RuntimeLoggingInput } from '@pluxel/runtime/logger'

export type StaticRuntimeContextConfig = Omit<
	CoreContext.Config,
	| 'configService'
	| 'runtimeState'
	| 'persistence'
	| 'database'
	| 'http'
	| 'workbench'
	| 'logger'
	| 'profile'
	| 'adminAccess'
	| 'workbenchArtifactRoot'
	| 'workbenchArtifactResolver'
	| 'nodeModuleArtifactRoot'
	| 'nodeModuleArtifactResolver'
>

export type StaticRuntimeEnvironment = Readonly<Record<string, string | undefined>>
export type StaticRuntimeBindings = Readonly<Record<string, unknown>>

export type StaticRuntimeDeployment = Readonly<{
	root: string
	target: 'node'
	variant: 'headless' | 'workbench'
}>

export type StaticRuntimeStartupContext<
	TBindings extends StaticRuntimeBindings = StaticRuntimeBindings,
> = Readonly<{
	mode: 'development' | 'production' | 'test'
	env: StaticRuntimeEnvironment
	bindings: TBindings
	deployment?: StaticRuntimeDeployment
}>

export type StaticRuntimeDefinition = {
	/**
	 * Stable runtime id used only for diagnostics and read models.
	 */
	name: string
	/**
	 * Fixed Plugin implementation generations. Identity comes from lowered root-entry/export facts.
	 */
	plugins: readonly PluginConstructor[]
}

export type StaticRuntimeApplication<
	TPlugins extends readonly PluginConstructor[] = readonly PluginConstructor[],
	TBindings extends StaticRuntimeBindings = StaticRuntimeBindings,
> = {
	/** Stable runtime id used for diagnostics, manifests, and read models. */
	name: string
	/** Fixed production catalog. Development Vite hosts may replace this graph through HMR. */
	plugins: TPlugins
	/** Bundled resolver code. Returned values are resolved again for every host startup. */
	configure?: (
		startup: StaticRuntimeStartupContext<TBindings>,
	) => StaticRuntimeHostOptions | Promise<StaticRuntimeHostOptions>
	/** Host-owned startup policy run after services are prepared and before plugins start. */
	prepare?: (input: {
		host: StaticRuntimeHost
		startup: StaticRuntimeStartupContext<TBindings>
	}) => void | Promise<void>
}

export type StaticRuntimeHostOptions = {
	/**
	 * Runtime config source used for plugin enablement and plugin config records.
	 *
	 * @default JSON config stored in the configured persistence backend.
	 */
	configService?: ConfigServiceConfig
	/**
	 * Runtime control-plane state source used for plugin enablement, fork metadata,
	 * dependency overrides, and built-in catalog state.
	 *
	 * @default JSON runtime state stored in the configured persistence backend.
	 */
	runtimeState?: RuntimeStateStoreConfig
	/**
	 * Shared runtime persistence backend used by config/state/logger/vault.
	 *
	 * @default In-memory persistence. Node hosts can pass a string root path.
	 */
	persistence?: PersistenceServiceConfig
	/** Shared lazy PostgreSQL capability. Omit for persistent local PGlite. */
	database?: DatabaseConfig
	/**
	 * HTTP runtime settings. Workbench UI/RPC/SSE are controlled by the top-level
	 * Workbench config.
	 */
	http?: HttpServiceConfig
	/** Optional Workbench Plane resources, UI artifacts, and access policy. @default false */
	workbench?: WorkbenchConfig
	/** Host-owned logging plan. `false` installs a silent root. */
	logging?: false | RuntimeLoggingInput
	/**
	 * Runtime profile used for diagnostics.
	 */
	profile?: CoreContext.Config['profile']
	/**
	 * Additional low-level runtime context config. Prefer top-level static runtime config
	 * fields for common runtime options.
	 *
	 * @default {}
	 */
	context?: StaticRuntimeContextConfig
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
	fetch: HttpHandler
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
	readonly address: PluginNodeAddress
	readonly displayName: string
	readonly rootExportName: string
	readonly status: StaticRuntimePluginStatus
	readonly message?: string
}

export type StaticRuntimeStartupReport = {
	readonly runtime: string
	readonly entries: readonly StaticRuntimeReportEntry[]
	readonly commit?: CommitSummary
}

export type StaticRuntimeHmrReport = StaticRuntimeStartupReport & {
	readonly added: readonly PluginNodeAddress[]
	readonly removed: readonly PluginNodeAddress[]
	readonly replaced: readonly PluginNodeAddress[]
}

export type StaticRuntimeCatalogEntry = {
	readonly address: PluginNodeAddress
	readonly definition: PluginDefinitionAddress
	readonly displayName: string
	readonly rootExportName: string
	readonly provenance: PluginEntryAddress
	/** Current implementation generation for this stable Plugin node. */
	readonly generation: PluginConstructor
}

export type StaticRuntimeCatalogSnapshot = {
	readonly runtime: string
	readonly plugins: readonly StaticRuntimeCatalogEntry[]
}
