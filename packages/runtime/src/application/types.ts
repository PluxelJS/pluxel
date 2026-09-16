import type { PluginSource } from '@pluxel/host'
import type {
	CommitSummary,
	PluginConstructor,
	PluginDefinitionAddress,
	PluginEntryAddress,
	PluginNodeAddress,
} from '@pluxel/core'
import type {
	ConfigServiceConfig,
	Context,
	PersistenceServiceConfig,
	DatabaseConfig,
	RuntimeStateStoreConfig,
	VaultServiceConfig,
	WorkbenchConfig,
	WorkersConfig,
} from '../index.ts'
import type { RuntimeLoggingInput } from '../logger.ts'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { PluxelEnvironmentVariables } from '../environment.ts'

declare const CONFIG_ENVIRONMENT_BINDING_BRAND: unique symbol

type NonNullish<T> = Exclude<T, null | undefined>

type RuntimeFetch = (request: Request, env?: unknown, ctx?: unknown) => Response | Promise<Response>

type ConfigEnvironmentObjectMapping<T> = [NonNullish<T>] extends [readonly unknown[]]
	? never
	: NonNullish<T> extends (...args: never[]) => unknown
		? never
		: string extends keyof NonNullish<T>
			? never
			: [NonNullish<T>] extends [object]
				? {
						readonly [K in keyof NonNullish<T>]?: ConfigEnvironmentMapping<NonNullish<T>[K]>
					}
				: never

/**
 * Recursively maps a Plugin schema's raw input fields to environment names.
 * Objects may be mapped as a whole or traversed; arrays, tuples, and scalar values are leaves.
 */
export type ConfigEnvironmentMapping<TInput> = string | ConfigEnvironmentObjectMapping<TInput>

/** Opaque config bootstrap declaration created by bindConfigEnvironment(). */
export type ConfigEnvironmentBinding = Readonly<{
	readonly [CONFIG_ENVIRONMENT_BINDING_BRAND]: true
}>

/** Schema accepted by bindConfigEnvironment(). */
export type ConfigEnvironmentSchema = StandardSchemaV1 &
	Readonly<{
		kind: 'schema'
		type: string
	}>

export type RuntimeEnvironment = PluxelEnvironmentVariables
export type RuntimeBindings = Readonly<Record<string, unknown>>

export type RuntimeDeployment = Readonly<{
	root: string
	target: 'node'
	variant: 'headless' | 'workbench'
}>

export type RuntimeStartupContext<TBindings extends RuntimeBindings = RuntimeBindings> = Readonly<{
	root: string
	mode: 'development' | 'production' | 'test'
	env: RuntimeEnvironment
	bindings: TBindings
	deployment?: RuntimeDeployment
}>

export type RuntimeDefinition = {
	/**
	 * Stable runtime id used only for diagnostics and read models.
	 */
	name: string
	/**
	 * Fixed Plugin implementations. Identity comes from lowered root-entry/export facts.
	 */
	plugins: readonly PluginConstructor[]
}

export type RuntimeApplication<
	TPlugins extends readonly PluginConstructor[] = readonly PluginConstructor[],
	TBindings extends RuntimeBindings = RuntimeBindings,
> = {
	/** Stable runtime id used for diagnostics, manifests, and read models. */
	name: string
	/** Fixed production catalog. Development Vite hosts may replace this graph through HMR. */
	plugins: TPlugins
	sources?: readonly PluginSource[]
	/**
	 * Environment names used only to initialize a new Plugin config store.
	 * Existing persisted config remains authoritative.
	 */
	configEnvironmentBootstrap?: readonly ConfigEnvironmentBinding[]
	/** Bundled resolver code. Returned values are resolved again for every host startup. */
	configure?: (
		startup: RuntimeStartupContext<TBindings>,
	) => RuntimeHostOptions | Promise<RuntimeHostOptions>
	/** Host-owned startup policy run after services are prepared and before plugins start. */
	prepare?: (input: {
		host: RuntimeHost
		startup: RuntimeStartupContext<TBindings>
	}) => void | Promise<void>
}

export type RuntimeHostOptions = {
	/**
	 * Runtime config source used for plugin config records.
	 *
	 * @default JSON config stored in the configured persistence backend.
	 */
	configService?: ConfigServiceConfig
	/**
	 * Runtime control-plane state source used for Plugin auto-start policy, fork metadata,
	 * provider defaults, and dependency overrides.
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
	/** Shared lazy PostgreSQL capability. Omit for local PGlite development/test use. */
	database?: DatabaseConfig
	/** Shared bounded worker-task execution policy. */
	workers?: WorkersConfig
	/** Explicitly installs headless management. Workbench also installs management when enabled. */
	management?: true
	/** Optional Workbench Direct View/Attachment plane and immutable MF producer artifacts. @default false */
	workbench?: WorkbenchConfig
	/** Explicitly enables the encrypted Vault. Omitted or `false` has zero backend cost. */
	vault?: false | VaultServiceConfig
	/** Runtime debug topics enabled for this host. */
	debug?: readonly string[]
	/** Host-owned logging plan. `false` installs a silent root. */
	logging?: false | RuntimeLoggingInput
	/**
	 * Runtime profile used for diagnostics.
	 */
	profile?: string
}

export type RuntimeHost = {
	readonly ctx: Context
	readonly hmr: RuntimeHmrController
	readonly definition: RuntimeDefinition
	fetch: RuntimeFetch
	start(): Promise<RuntimeStartupReport>
	stop(): Promise<void>
	describeCatalog(): RuntimeCatalogSnapshot
	lastReport(): RuntimeStartupReport | undefined
}

export type Runtime = {
	readonly ctx: Context
	readonly startupReport: RuntimeStartupReport
	fetch: RuntimeFetch
	start(): Promise<RuntimeStartupReport>
	stop(): Promise<void>
}

export type RuntimeHmrController = {
	reload(definition: RuntimeDefinition): Promise<RuntimeHmrReport>
}

export type RuntimePluginStatus =
	| 'started'
	| 'stopped'
	| 'config-invalid'
	| 'dependency-missing'
	| 'dependency-failed'
	| 'unavailable'
	| 'start-failed'
	| 'unknown-config-entry'
	| 'catalog-drift'

export type RuntimeReportEntry = {
	readonly address: PluginNodeAddress
	readonly displayName: string
	readonly rootExportName: string
	readonly status: RuntimePluginStatus
	readonly message?: string
}

export type RuntimeStartupReport = {
	readonly runtime: string
	readonly entries: readonly RuntimeReportEntry[]
}

/** @internal Runtime/Vite report retaining process-local Core planning facts. */
export type RuntimeInternalStartupReport = RuntimeStartupReport & {
	readonly commit?: CommitSummary
}

export type RuntimeHmrReport = RuntimeStartupReport & {
	readonly added: readonly PluginNodeAddress[]
	readonly removed: readonly PluginNodeAddress[]
	readonly replaced: readonly PluginNodeAddress[]
}

/** @internal Vite/HMR report retaining process-local Core planning facts. */
export type RuntimeInternalHmrReport = RuntimeHmrReport & {
	readonly commit?: CommitSummary
}

export type RuntimeCatalogEntry = {
	readonly address: PluginNodeAddress
	readonly definition: PluginDefinitionAddress
	readonly displayName: string
	readonly rootExportName: string
	readonly provenance: PluginEntryAddress
}

export type RuntimeCatalogSnapshot = {
	readonly runtime: string
	readonly plugins: readonly RuntimeCatalogEntry[]
}
