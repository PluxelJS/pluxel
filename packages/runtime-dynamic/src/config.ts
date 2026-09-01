import type { PluginConstructor } from '@pluxel/core'
import {
	assertKnownConfigFields,
	assertRuntimeServiceConfigFields,
	closedConfigFields,
	type ExactConfigShape,
	type RuntimeHostConfig,
} from '@pluxel/runtime/internal/config-validation'
import type { RuntimeLoggingInput } from '@pluxel/runtime/logger'
import { assertDynamicPluginSources, type DynamicPluginSource } from './sources'

const DYNAMIC_RUNTIME_CONFIG_MARKER = Symbol.for('pluxel.dynamicRuntimeConfig')
export type DynamicRuntimeStorageOptions = Readonly<{
	/** Directory for config/runtime-state persistence, relative to `root` unless absolute. */
	persistenceDir?: string
}>

export type DynamicRuntimeConfig = {
	root?: string
	configPath?: string
	profile?: string
	env?: Record<string, string | undefined>
	omitPackages?: string[]
	logsDir?: string
	logFile?: string
	storage?: DynamicRuntimeStorageOptions
	printUrls?: boolean
	/** Fixed catalog constructors. Availability does not create auto-start policy or session intent. */
	plugins?: readonly PluginConstructor[]
	/**
	 * Exact files or explicitly filtered directories whose entries form the mutable catalog.
	 * When omitted, only entries selected by the workspace HMR profile are loaded.
	 */
	sources?: readonly DynamicPluginSource[]
	configService?: RuntimeHostConfig['configService']
	runtimeState?: RuntimeHostConfig['runtimeState']
	persistence?: RuntimeHostConfig['persistence']
	database?: RuntimeHostConfig['database']
	workers?: RuntimeHostConfig['workers']
	management?: RuntimeHostConfig['management']
	workbench?: RuntimeHostConfig['workbench']
	vault?: RuntimeHostConfig['vault']
	debug?: RuntimeHostConfig['debug']
	logging?: false | RuntimeLoggingInput
}

const DYNAMIC_RUNTIME_CONFIG_FIELDS = closedConfigFields<DynamicRuntimeConfig>({
	root: true,
	configPath: true,
	profile: true,
	env: true,
	omitPackages: true,
	logsDir: true,
	logFile: true,
	storage: true,
	printUrls: true,
	plugins: true,
	sources: true,
	configService: true,
	runtimeState: true,
	persistence: true,
	database: true,
	workers: true,
	management: true,
	workbench: true,
	vault: true,
	debug: true,
	logging: true,
})
const DYNAMIC_RUNTIME_STORAGE_FIELDS = closedConfigFields<DynamicRuntimeStorageOptions>({
	persistenceDir: true,
})

type MarkedDynamicRuntimeConfig = DynamicRuntimeConfig & {
	readonly [DYNAMIC_RUNTIME_CONFIG_MARKER]?: true
}

type ExactDynamicRuntimeConfigConstraint<Config> = [Config] extends [DynamicRuntimeConfig]
	? [Config] extends [ExactConfigShape<Config, DynamicRuntimeConfig>]
		? unknown
		: never
	: never

export function defineDynamicRuntimeConfig<const T>(
	config: T & ExactDynamicRuntimeConfigConstraint<T>,
): T {
	assertDynamicRuntimeConfig(config)
	Object.defineProperty(config, DYNAMIC_RUNTIME_CONFIG_MARKER, {
		value: true,
		enumerable: false,
		configurable: false,
	})
	return config
}

export function assertDynamicRuntimeConfig(
	config: unknown,
): asserts config is DynamicRuntimeConfig {
	if (!config || typeof config !== 'object' || Array.isArray(config)) {
		throw new TypeError('[runtime-dynamic] Dynamic runtime config must be an object')
	}
	if ('vite' in config) {
		throw new Error(
			'[runtime-dynamic] Dynamic runtime config must not include a nested "vite" field; use the host vite.config.ts instead',
		)
	}
	if ('hmr' in config) {
		throw new Error(
			'[runtime-dynamic] Dynamic runtime config must not include an "hmr" field; loader HMR belongs to @pluxel/runtime-dynamic internals and host Vite wiring.',
		)
	}
	if ('deps' in config) {
		throw new Error(
			'[runtime-dynamic] Dynamic runtime config must not include a "deps" tuning object; bridge, host-module, SSR and optimizer policy belong to the runtime.',
		)
	}
	if ('cjsExternal' in config) {
		throw new Error(
			'[runtime-dynamic] Dynamic runtime config must not include "cjsExternal"; CommonJS and native host modules are detected automatically.',
		)
	}
	assertKnownConfigFields(
		config,
		DYNAMIC_RUNTIME_CONFIG_FIELDS,
		'[runtime-dynamic] Dynamic runtime config',
	)
	const runtimeConfig = config as DynamicRuntimeConfig
	assertStorageConfig(runtimeConfig.storage)
	assertRuntimeServiceConfigFields(config, '[runtime-dynamic] Dynamic runtime config')
	assertFixedPlugins(runtimeConfig.plugins)
	assertDynamicPluginSources(runtimeConfig.sources)
}

function assertFixedPlugins(value: unknown): asserts value is readonly PluginConstructor[] {
	if (value === undefined) return
	if (!Array.isArray(value) || value.some((plugin) => typeof plugin !== 'function')) {
		throw new TypeError('[runtime-dynamic] plugins must be an array of plugin constructors')
	}
}

export function isDynamicRuntimeConfig(value: unknown): value is DynamicRuntimeConfig {
	return Boolean(
		value &&
		typeof value === 'object' &&
		(value as MarkedDynamicRuntimeConfig)[DYNAMIC_RUNTIME_CONFIG_MARKER] === true,
	)
}

function assertStorageConfig(storage: unknown): void {
	if (storage === undefined) return
	if (!storage || typeof storage !== 'object' || Array.isArray(storage)) {
		throw new TypeError('[runtime-dynamic] storage must be an object')
	}
	assertKnownConfigFields(storage, DYNAMIC_RUNTIME_STORAGE_FIELDS, '[runtime-dynamic] storage')
	const persistenceDir = (storage as Record<string, unknown>).persistenceDir
	if (
		persistenceDir !== undefined &&
		(typeof persistenceDir !== 'string' || !persistenceDir.trim() || persistenceDir.includes('\0'))
	) {
		throw new TypeError('[runtime-dynamic] storage.persistenceDir must be a non-empty path')
	}
}
