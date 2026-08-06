import type { Context as CoreContext, PluginConstructor } from '@pluxel/core'
import type { WorkbenchConfig } from '@pluxel/runtime'
import type { RuntimeLoggingInput } from '@pluxel/runtime/logger'
import { assertDynamicPluginSources, type DynamicPluginSource } from './sources'

const DYNAMIC_RUNTIME_CONFIG_MARKER = Symbol.for('pluxel.dynamicRuntimeConfig')
const DYNAMIC_RUNTIME_CONFIG_FIELDS = new Set([
	'root',
	'configPath',
	'profile',
	'env',
	'omitPackages',
	'logsDir',
	'logFile',
	'storage',
	'printUrls',
	'plugins',
	'sources',
	'configService',
	'runtimeState',
	'persistence',
	'database',
	'http',
	'workbench',
	'logging',
])
const DYNAMIC_RUNTIME_STORAGE_FIELDS = new Set(['persistenceDir'])

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
	/** Fixed catalog constructors. Availability does not implicitly enable a plugin. */
	plugins?: readonly PluginConstructor[]
	/**
	 * Exact files or explicitly filtered directories whose entries form the mutable catalog.
	 * When omitted, only entries selected by the workspace HMR profile are loaded.
	 */
	sources?: readonly DynamicPluginSource[]
	configService?: CoreContext.Config['configService']
	runtimeState?: CoreContext.Config['runtimeState']
	persistence?: CoreContext.Config['persistence']
	database?: CoreContext.Config['database']
	http?: CoreContext.Config['http']
	workbench?: WorkbenchConfig
	logging?: false | RuntimeLoggingInput
}

type MarkedDynamicRuntimeConfig = DynamicRuntimeConfig & {
	readonly [DYNAMIC_RUNTIME_CONFIG_MARKER]?: true
}

export function defineDynamicRuntimeConfig<T extends DynamicRuntimeConfig>(config: T): T {
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
	assertKnownFields(
		config,
		DYNAMIC_RUNTIME_CONFIG_FIELDS,
		'[runtime-dynamic] Dynamic runtime config',
	)
	const runtimeConfig = config as DynamicRuntimeConfig
	assertPublicHttpConfig(runtimeConfig.http, '[runtime-dynamic] Dynamic runtime config')
	assertStorageConfig(runtimeConfig.storage)
	assertFixedPlugins(runtimeConfig.plugins)
	assertDynamicPluginSources(runtimeConfig.sources)
}

function assertFixedPlugins(value: unknown): asserts value is readonly PluginConstructor[] {
	if (value === undefined) return
	if (!Array.isArray(value) || value.some((plugin) => typeof plugin !== 'function')) {
		throw new TypeError('[runtime-dynamic] plugins must be an array of plugin constructors')
	}
}

function assertKnownFields(value: object, allowed: ReadonlySet<string>, label: string): void {
	const unknown = Object.keys(value).filter((key) => !allowed.has(key))
	if (unknown.length === 0) return
	throw new Error(`${label} includes unsupported ${unknown.map((key) => `"${key}"`).join(', ')}`)
}

export function isDynamicRuntimeConfig(value: unknown): value is DynamicRuntimeConfig {
	return Boolean(
		value &&
		typeof value === 'object' &&
		(value as MarkedDynamicRuntimeConfig)[DYNAMIC_RUNTIME_CONFIG_MARKER] === true,
	)
}

function assertPublicHttpConfig(http: unknown, label: string): void {
	if (!http || typeof http !== 'object') return
	const forbidden = ['workbench', 'controlPlane', 'uiAssets', 'uiPublicDir'].filter(
		(key) => key in http,
	)
	if (forbidden.length === 0) return
	throw new Error(
		`${label} http must not include ${forbidden.map((key) => `"${key}"`).join(', ')}; use top-level "workbench" and let the route launcher own workbench internals.`,
	)
}

function assertStorageConfig(storage: unknown): void {
	if (storage === undefined) return
	if (!storage || typeof storage !== 'object' || Array.isArray(storage)) {
		throw new TypeError('[runtime-dynamic] storage must be an object')
	}
	assertKnownFields(storage, DYNAMIC_RUNTIME_STORAGE_FIELDS, '[runtime-dynamic] storage')
	const persistenceDir = (storage as Record<string, unknown>).persistenceDir
	if (
		persistenceDir !== undefined &&
		(typeof persistenceDir !== 'string' || !persistenceDir.trim() || persistenceDir.includes('\0'))
	) {
		throw new TypeError('[runtime-dynamic] storage.persistenceDir must be a non-empty path')
	}
}
