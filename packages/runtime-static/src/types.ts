import type {
	Context as CoreContext,
	CommitSummary,
	PluginConstructor,
} from '@pluxel/core'
import type { Context } from '@pluxel/runtime'
import type { ConfigServiceConfig } from '@pluxel/runtime/services'

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

export type StaticRuntimeHostOptions = {
	/**
	 * Runtime config source used for plugin enablement and plugin config records.
	 *
	 * @default File-backed runtime config resolved by @pluxel/runtime.
	 */
	configService?: ConfigServiceConfig
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

export type StaticRuntimeHmrController = {
	reload(definition: StaticRuntimeDefinition): Promise<StaticRuntimeHmrReport>
}

export type StaticRuntimePluginStatus =
	| 'started'
	| 'disabled'
	| 'config-invalid'
	| 'dependency-missing'
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
