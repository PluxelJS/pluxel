import type { PluginConfigRecordSnapshot } from '@pluxel/core/services'
import type {
	RuntimeConsoleSinkInput,
	RuntimeCustomSinkInput,
	RuntimeFileSinkInput,
	RuntimeLoggingInput,
	RuntimeLoggingRootInput,
	RuntimeLoggingRouteBinding,
	RuntimeStoreSinkInput,
} from '../logger/logging'
import type { PluginLogPolicyOverride, PluginLogPolicySnapshot } from '../logger/policy'
import type { WorkersConfig } from '../node-artifact/worker-task'
import type { ConfigServiceConfig } from '../services/ConfigService'
import type { DatabaseConfig } from '../services/DatabaseService'
import type {
	PersistenceBackend,
	PersistenceServiceConfig,
} from '../services/persistence/PersistenceService'
import type {
	RuntimeDependencyOverrideState,
	RuntimeForkState,
	RuntimeProviderDefaultState,
	RuntimeStateStoreConfig,
} from '../services/RuntimeStateStore'
import type { RuntimeHttpAssetConfig } from '../services/http/HttpService'
import type { VaultServiceConfig } from '../services/vault/types'
import { resolveRuntimePlanePlan } from '../runtime-plane'
import type { RuntimeHostConfig } from './runtime-contract'

type ExactConfigObjectInvalidKeys<Actual extends object, Expected extends object> = {
	[Key in keyof Actual]-?: Key extends keyof Expected
		? [Actual[Key]] extends [ExactConfigShape<Actual[Key], Expected[Key]>]
			? never
			: Key
		: Key
}[keyof Actual]

type ExactConfigObject<Actual extends object, Expected extends object> = [
	ExactConfigObjectInvalidKeys<Actual, Expected>,
] extends [never]
	? Actual
	: never

/** @internal Recursively rejects unknown fields while preserving explicitly open config values. */
export type ExactConfigShape<Actual, Expected> = Actual extends unknown
	? Expected extends unknown
		? Actual extends Expected
			? Expected extends (...args: infer _Args) => unknown
				? Actual
				: Expected extends abstract new (...args: infer _Args) => unknown
					? Actual
					: Expected extends readonly (infer ExpectedItem)[]
						? Actual extends readonly (infer ActualItem)[]
							? [ActualItem] extends [ExactConfigShape<ActualItem, ExpectedItem>]
								? Actual
								: never
							: never
						: Expected extends PersistenceBackend
							? Actual
							: Expected extends object
								? Expected extends Iterable<infer ExpectedItem>
									? Actual extends Iterable<infer ActualItem>
										? [ActualItem] extends [ExactConfigShape<ActualItem, ExpectedItem>]
											? Actual
											: never
										: never
									: Actual extends object
										? ExactConfigObject<Actual, Expected>
										: never
								: Actual
			: never
		: never
	: never

type ClosedConfigFields<Config extends object> = {
	readonly [Key in keyof Config]-?: true
}

/** @internal Defines an exhaustive runtime field set for one closed configuration object. */
export function closedConfigFields<Config extends object>(
	fields: ClosedConfigFields<Config>,
): ReadonlySet<string> {
	return new Set(Object.keys(fields))
}

/** @internal Rejects fields outside an exhaustive closed configuration contract. */
export function assertKnownConfigFields(
	config: object,
	allowed: ReadonlySet<string>,
	label: string,
): void {
	const unknown = Object.getOwnPropertyNames(config).filter((field) => !allowed.has(field))
	if (unknown.length === 0) return
	throw new TypeError(
		`${label} includes unsupported ${unknown.map((field) => `"${field}"`).join(', ')}`,
	)
}

type ConfigServiceSnapshot = NonNullable<ConfigServiceConfig['snapshot']>
type RuntimeStateConfigSnapshot = NonNullable<RuntimeStateStoreConfig['snapshot']>
type MemoryPersistenceConfig = Extract<PersistenceServiceConfig, { mode: 'memory' }>
type CustomPersistenceConfig = Extract<PersistenceServiceConfig, { mode: 'custom' }>
type ReadonlyPersistenceConfig = Extract<PersistenceServiceConfig, { mode: 'readonly' }>
type ReadonlyBackendPersistenceConfig = Extract<ReadonlyPersistenceConfig, { backend: unknown }>
type ReadonlyDirectoryPersistenceConfig = Extract<ReadonlyPersistenceConfig, { dir: unknown }>
type PgliteDatabaseConfig = Extract<DatabaseConfig, { driver: 'pglite' }>
type PostgresDatabaseConfig = Extract<DatabaseConfig, { driver: 'postgres' }>
type PostgresPoolConfig = NonNullable<PostgresDatabaseConfig['pool']>
type RuntimeStoreCaps = NonNullable<RuntimeStoreSinkInput['caps']>
type RuntimeLoggingRoutes = RuntimeLoggingInput['routes']
type RuntimeLoggerConfig = NonNullable<RuntimeHostConfig['logger']>
type RuntimeEventsConfig = NonNullable<RuntimeHostConfig['events']>
type RuntimePluginsConfig = NonNullable<RuntimeHostConfig['plugins']>
type EnabledWorkbenchConfig = Exclude<RuntimeHostConfig['workbench'], false | undefined>

const RUNTIME_HOST_FIELDS = closedConfigFields<RuntimeHostConfig>({
	name: true,
	logger: true,
	events: true,
	plugins: true,
	configService: true,
	runtimeState: true,
	persistence: true,
	database: true,
	workers: true,
	http: true,
	management: true,
	workbench: true,
	debug: true,
	vault: true,
	workbenchArtifactRoot: true,
	nodeModuleArtifactRoot: true,
	nodeModuleArtifactResolver: true,
})
const CONFIG_SERVICE_FIELDS = closedConfigFields<ConfigServiceConfig>({
	mode: true,
	snapshot: true,
	environment: true,
})
const CONFIG_SERVICE_SNAPSHOT_FIELDS = closedConfigFields<ConfigServiceSnapshot>({ plugins: true })
const PLUGIN_CONFIG_RECORD_FIELDS = closedConfigFields<PluginConfigRecordSnapshot>({
	owner: true,
	config: true,
})
const RUNTIME_STATE_FIELDS = closedConfigFields<RuntimeStateStoreConfig>({
	mode: true,
	snapshot: true,
})
const RUNTIME_STATE_SNAPSHOT_FIELDS = closedConfigFields<RuntimeStateConfigSnapshot>({
	autoStart: true,
	forks: true,
	providerDefaults: true,
	dependencyOverrides: true,
})
const RUNTIME_FORK_FIELDS = closedConfigFields<RuntimeForkState>({
	definition: true,
	forkIds: true,
})
const RUNTIME_PROVIDER_DEFAULT_FIELDS = closedConfigFields<RuntimeProviderDefaultState>({
	token: true,
	provider: true,
})
const RUNTIME_DEPENDENCY_OVERRIDE_FIELDS = closedConfigFields<RuntimeDependencyOverrideState>({
	consumerAddress: true,
	requirementAddress: true,
	providerAddress: true,
})
const MEMORY_PERSISTENCE_FIELDS = closedConfigFields<MemoryPersistenceConfig>({ mode: true })
const CUSTOM_PERSISTENCE_FIELDS = closedConfigFields<CustomPersistenceConfig>({
	mode: true,
	backend: true,
})
const READONLY_BACKEND_PERSISTENCE_FIELDS = closedConfigFields<ReadonlyBackendPersistenceConfig>({
	mode: true,
	backend: true,
})
const READONLY_DIRECTORY_PERSISTENCE_FIELDS =
	closedConfigFields<ReadonlyDirectoryPersistenceConfig>({ mode: true, dir: true })
const PGLITE_DATABASE_FIELDS = closedConfigFields<PgliteDatabaseConfig>({
	driver: true,
	dataDir: true,
})
const POSTGRES_DATABASE_FIELDS = closedConfigFields<PostgresDatabaseConfig>({
	driver: true,
	connectionString: true,
	pool: true,
	tls: true,
})
const POSTGRES_POOL_FIELDS = closedConfigFields<PostgresPoolConfig>({
	max: true,
	idleTimeoutMs: true,
	connectionTimeoutMs: true,
})
const WORKERS_FIELDS = closedConfigFields<WorkersConfig>({
	maxThreads: true,
	maxQueuedTasks: true,
	maxQueuedTasksPerPlugin: true,
	idleTimeoutMs: true,
})
const WORKBENCH_FIELDS = closedConfigFields<EnabledWorkbenchConfig>({
	enabled: true,
	uiBasePath: true,
})
const VAULT_FIELDS = closedConfigFields<VaultServiceConfig>({
	flushDebounceMs: true,
	deployIdentityEnv: true,
})
const LOGGING_FIELDS = closedConfigFields<RuntimeLoggingInput>({
	root: true,
	sinks: true,
	routes: true,
})
const LOGGING_ROOT_FIELDS = closedConfigFields<RuntimeLoggingRootInput>({
	profile: true,
	initialPluginPolicy: true,
	debugTopics: true,
	policyLoadFailure: true,
})
const LOGGING_POLICY_FIELDS = closedConfigFields<PluginLogPolicySnapshot>({
	version: true,
	defaultLevel: true,
	overrides: true,
})
const LOGGING_POLICY_OVERRIDE_FIELDS = closedConfigFields<PluginLogPolicyOverride>({
	owner: true,
	level: true,
})
const CONSOLE_SINK_FIELDS = closedConfigFields<RuntimeConsoleSinkInput>({
	kind: true,
	format: true,
	caller: true,
	timezone: true,
})
const FILE_SINK_FIELDS = closedConfigFields<RuntimeFileSinkInput>({
	kind: true,
	path: true,
	format: true,
	caller: true,
	timezone: true,
})
const STORE_SINK_FIELDS = closedConfigFields<RuntimeStoreSinkInput>({
	kind: true,
	caller: true,
	streamId: true,
	minLevel: true,
	bufferSize: true,
	flushIntervalMs: true,
	windowLines: true,
	hiddenKeys: true,
	redactKeys: true,
	includeRaw: true,
	caps: true,
})
const STORE_CAPS_FIELDS = closedConfigFields<RuntimeStoreCaps>({
	maxMsgChars: true,
	maxMessageParts: true,
	maxMessagePartChars: true,
	maxPropsKeys: true,
})
const CUSTOM_SINK_FIELDS = closedConfigFields<RuntimeCustomSinkInput>({
	kind: true,
	label: true,
	sink: true,
	caller: true,
})
const LOGGING_ROUTES_FIELDS = closedConfigFields<RuntimeLoggingRoutes>({
	runtime: true,
	plugins: true,
	debug: true,
	meta: true,
})
const LOGGING_ROUTE_FIELDS = closedConfigFields<RuntimeLoggingRouteBinding>({
	sink: true,
	minLevel: true,
})
const LOGGER_FIELDS = closedConfigFields<RuntimeLoggerConfig>({ rootId: true })
const EVENTS_FIELDS = closedConfigFields<RuntimeEventsConfig>({
	events: true,
	catchPromiseError: true,
	checkSyncFuncReturnPromise: true,
	errorPolicy: true,
})
const PLUGINS_FIELDS = closedConfigFields<RuntimePluginsConfig>({
	startTimeoutMs: true,
	drainTimeoutMs: true,
	startConcurrency: true,
	stopConcurrency: true,
})
const HTTP_FIELDS = closedConfigFields<RuntimeHttpAssetConfig>({
	uiAssets: true,
	uiPublicDir: true,
})

/** @internal Validates the complete Runtime-owned host contract before Context construction. */
export function assertRuntimeHostConfig(
	input: unknown,
	label = '[pluxel/runtime] host config',
): void {
	const config = configObject(input, label)
	assertKnownConfigFields(config, RUNTIME_HOST_FIELDS, label)
	assertOptionalClosedConfig(config.logger, LOGGER_FIELDS, `${label}.logger`)
	assertOptionalClosedConfig(config.events, EVENTS_FIELDS, `${label}.events`)
	assertOptionalClosedConfig(config.plugins, PLUGINS_FIELDS, `${label}.plugins`)
	assertOptionalClosedConfig(config.http, HTTP_FIELDS, `${label}.http`)
	assertRuntimeServiceConfigFields(config, label)
}

/** @internal Validates every public Runtime service config nested under a route config. */
export function assertRuntimeServiceConfigFields(input: object, label: string): void {
	const config = input as Record<string, unknown>
	assertConfigServiceConfig(config.configService, `${label}.configService`)
	assertRuntimeStateConfig(config.runtimeState, `${label}.runtimeState`)
	assertPersistenceConfig(config.persistence, `${label}.persistence`)
	assertDatabaseConfig(config.database, `${label}.database`)
	assertOptionalClosedConfig(config.workers, WORKERS_FIELDS, `${label}.workers`)
	if (config.workbench !== undefined && config.workbench !== false) {
		assertOptionalClosedConfig(config.workbench, WORKBENCH_FIELDS, `${label}.workbench`)
	}
	resolveRuntimePlanePlan(
		config.workbench as RuntimeHostConfig['workbench'],
		config.management as RuntimeHostConfig['management'],
	)
	assertVaultConfig(config.vault, `${label}.vault`)
	assertDebugConfig(config.debug, `${label}.debug`)
	if (config.logging !== undefined && config.logging !== false) {
		assertRuntimeLoggingInput(config.logging, `${label}.logging`)
	}
}

/** @internal Validates the closed structural fields in a Runtime logging plan. */
export function assertRuntimeLoggingInput(
	input: unknown,
	label = '[pluxel/runtime] logging',
): void {
	const logging = configObject(input, label)
	assertKnownConfigFields(logging, LOGGING_FIELDS, label)

	const root = configObject(logging.root, `${label}.root`)
	assertKnownConfigFields(root, LOGGING_ROOT_FIELDS, `${label}.root`)
	if (root.initialPluginPolicy !== undefined) {
		assertLoggingPolicy(root.initialPluginPolicy, `${label}.root.initialPluginPolicy`)
	}

	const sinks = configObject(logging.sinks, `${label}.sinks`)
	for (const [sinkId, inputSink] of Object.entries(sinks)) {
		const sinkLabel = `${label}.sinks[${JSON.stringify(sinkId)}]`
		const sink = configObject(inputSink, sinkLabel)
		switch (sink.kind) {
			case 'console':
				assertKnownConfigFields(sink, CONSOLE_SINK_FIELDS, sinkLabel)
				break
			case 'file':
				assertKnownConfigFields(sink, FILE_SINK_FIELDS, sinkLabel)
				break
			case 'store':
				assertKnownConfigFields(sink, STORE_SINK_FIELDS, sinkLabel)
				assertOptionalClosedConfig(sink.caps, STORE_CAPS_FIELDS, `${sinkLabel}.caps`)
				break
			case 'logtape':
				assertKnownConfigFields(sink, CUSTOM_SINK_FIELDS, sinkLabel)
				break
			default:
				throw new TypeError(`${sinkLabel}.kind must identify a supported logging sink`)
		}
	}

	const routes = configObject(logging.routes, `${label}.routes`)
	assertKnownConfigFields(routes, LOGGING_ROUTES_FIELDS, `${label}.routes`)
	for (const family of ['runtime', 'plugins', 'debug', 'meta'] as const) {
		const bindings = routes[family]
		if (!Array.isArray(bindings)) {
			throw new TypeError(`${label}.routes.${family} must be an array`)
		}
		bindings.forEach((binding, index) => {
			const bindingLabel = `${label}.routes.${family}[${index}]`
			const record = configObject(binding, bindingLabel)
			assertKnownConfigFields(record, LOGGING_ROUTE_FIELDS, bindingLabel)
		})
	}
}

function assertConfigServiceConfig(input: unknown, label: string): void {
	if (input === undefined) return
	const config = configObject(input, label)
	assertKnownConfigFields(config, CONFIG_SERVICE_FIELDS, label)
	if (config.snapshot !== undefined) {
		const snapshot = configObject(config.snapshot, `${label}.snapshot`)
		assertKnownConfigFields(snapshot, CONFIG_SERVICE_SNAPSHOT_FIELDS, `${label}.snapshot`)
		if (snapshot.plugins !== undefined) {
			if (!Array.isArray(snapshot.plugins)) {
				throw new TypeError(`${label}.snapshot.plugins must be an array`)
			}
			snapshot.plugins.forEach((entry, index) => {
				const entryLabel = `${label}.snapshot.plugins[${index}]`
				const record = configObject(entry, entryLabel)
				assertKnownConfigFields(record, PLUGIN_CONFIG_RECORD_FIELDS, entryLabel)
			})
		}
	}
}

function assertRuntimeStateConfig(input: unknown, label: string): void {
	if (input === undefined) return
	const config = configObject(input, label)
	assertKnownConfigFields(config, RUNTIME_STATE_FIELDS, label)
	if (config.snapshot === undefined) return
	const snapshot = configObject(config.snapshot, `${label}.snapshot`)
	assertKnownConfigFields(snapshot, RUNTIME_STATE_SNAPSHOT_FIELDS, `${label}.snapshot`)
	assertArrayEntries(snapshot.forks, RUNTIME_FORK_FIELDS, `${label}.snapshot.forks`)
	assertArrayEntries(
		snapshot.providerDefaults,
		RUNTIME_PROVIDER_DEFAULT_FIELDS,
		`${label}.snapshot.providerDefaults`,
	)
	assertArrayEntries(
		snapshot.dependencyOverrides,
		RUNTIME_DEPENDENCY_OVERRIDE_FIELDS,
		`${label}.snapshot.dependencyOverrides`,
	)
}

function assertPersistenceConfig(input: unknown, label: string): void {
	if (input === undefined || typeof input === 'string') return
	const config = configObject(input, label)
	switch (config.mode) {
		case 'memory':
			assertKnownConfigFields(config, MEMORY_PERSISTENCE_FIELDS, label)
			return
		case 'custom':
			assertKnownConfigFields(config, CUSTOM_PERSISTENCE_FIELDS, label)
			return
		case 'readonly': {
			const backend = Object.hasOwn(config, 'backend')
			const directory = Object.hasOwn(config, 'dir')
			if (backend === directory) {
				throw new TypeError(`${label} readonly mode requires exactly one of backend or dir`)
			}
			assertKnownConfigFields(
				config,
				backend ? READONLY_BACKEND_PERSISTENCE_FIELDS : READONLY_DIRECTORY_PERSISTENCE_FIELDS,
				label,
			)
			return
		}
		default:
			// The Persistence service owns invalid mode and legacy-shape diagnostics.
			return
	}
}

function assertDatabaseConfig(input: unknown, label: string): void {
	if (input === undefined || input === false) return
	const config = configObject(input, label)
	switch (config.driver) {
		case 'pglite':
			assertKnownConfigFields(config, PGLITE_DATABASE_FIELDS, label)
			return
		case 'postgres':
			assertKnownConfigFields(config, POSTGRES_DATABASE_FIELDS, label)
			assertOptionalClosedConfig(config.pool, POSTGRES_POOL_FIELDS, `${label}.pool`)
			return
		default:
			throw new TypeError(`${label}.driver must be pglite or postgres`)
	}
}

function assertVaultConfig(input: unknown, label: string): void {
	if (input === undefined || input === false) return
	const config = configObject(input, label)
	assertKnownConfigFields(config, VAULT_FIELDS, label)
}

function assertDebugConfig(input: unknown, label: string): void {
	if (input === undefined) return
	if (!Array.isArray(input) || input.some((topic) => typeof topic !== 'string')) {
		throw new TypeError(`${label} must be an array of strings`)
	}
}

function assertLoggingPolicy(input: unknown, label: string): void {
	const policy = configObject(input, label)
	assertKnownConfigFields(policy, LOGGING_POLICY_FIELDS, label)
	if (!Array.isArray(policy.overrides)) {
		throw new TypeError(`${label}.overrides must be an array`)
	}
	policy.overrides.forEach((override, index) => {
		const overrideLabel = `${label}.overrides[${index}]`
		const record = configObject(override, overrideLabel)
		assertKnownConfigFields(record, LOGGING_POLICY_OVERRIDE_FIELDS, overrideLabel)
	})
}

function assertArrayEntries(input: unknown, fields: ReadonlySet<string>, label: string): void {
	if (input === undefined) return
	if (!Array.isArray(input)) throw new TypeError(`${label} must be an array`)
	input.forEach((entry, index) => {
		const entryLabel = `${label}[${index}]`
		const record = configObject(entry, entryLabel)
		assertKnownConfigFields(record, fields, entryLabel)
	})
}

function assertOptionalClosedConfig(
	input: unknown,
	fields: ReadonlySet<string>,
	label: string,
): void {
	if (input === undefined) return
	const config = configObject(input, label)
	assertKnownConfigFields(config, fields, label)
}

function configObject(input: unknown, label: string): Record<string, unknown> {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		throw new TypeError(`${label} must be an object`)
	}
	return input as Record<string, unknown>
}
