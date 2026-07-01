import type { BuiltinPluginSpec } from './services'
import type { LoaderHmrDependencyConfig } from './hmr/engine/config'
import type { LoaderHmrConfig } from './hmr/engine/LoaderHmrService'
import type { LoaderHmrHostStorageOptions } from './hmr/host'

const DYNAMIC_RUNTIME_CONFIG_MARKER = Symbol.for('pluxel.dynamicRuntimeConfig')

export type DynamicRuntimeConfig = {
	root?: string
	configPath?: string
	profile?: string
	env?: Record<string, string | undefined>
	omitPackages?: string[]
	logsDir?: string
	logFile?: string
	storage?: LoaderHmrHostStorageOptions
	warmup?: boolean
	printUrls?: boolean
	deps?: LoaderHmrDependencyConfig
	cjsExternal?: readonly string[]
	builtins?: readonly BuiltinPluginSpec[]
	builtinsFromDist?: LoaderHmrConfig['builtinsFromDist']
	context?: Record<string, unknown>
}

type MarkedDynamicRuntimeConfig = DynamicRuntimeConfig & {
	readonly [DYNAMIC_RUNTIME_CONFIG_MARKER]?: true
}

export function defineDynamicRuntimeConfig<T extends DynamicRuntimeConfig>(config: T): T {
	if ('vite' in config) {
		throw new Error(
			'[runtime-dynamic] Dynamic runtime config must not include a nested "vite" field; use the host vite.config.ts instead',
		)
	}
	Object.defineProperty(config, DYNAMIC_RUNTIME_CONFIG_MARKER, {
		value: true,
		enumerable: false,
		configurable: false,
	})
	return config
}

export function isDynamicRuntimeConfig(value: unknown): value is DynamicRuntimeConfig {
	return Boolean(
		value &&
			typeof value === 'object' &&
			(value as MarkedDynamicRuntimeConfig)[DYNAMIC_RUNTIME_CONFIG_MARKER] === true,
	)
}
