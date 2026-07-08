import type { Context as CoreContext } from '@pluxel/core'
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
	configService?: CoreContext.Config['configService']
	runtimeState?: CoreContext.Config['runtimeState']
	persistence?: CoreContext.Config['persistence']
	pluginData?: CoreContext.Config['pluginData']
	http?: CoreContext.Config['http']
	adminAccess?: CoreContext.Config['adminAccess']
	logger?: CoreContext.Config['logger']
	context?: CoreContext.Config
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
	if ('hmr' in config) {
		throw new Error(
			'[runtime-dynamic] Dynamic runtime config must not include an "hmr" field; loader HMR belongs to @pluxel/runtime-dynamic internals and host Vite wiring.',
		)
	}
	assertPublicHttpConfig(config.http, '[runtime-dynamic] Dynamic runtime config')
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

function assertPublicHttpConfig(http: unknown, label: string): void {
	if (!http || typeof http !== 'object') return
	const forbidden = ['management', 'controlPlane', 'uiAssets', 'uiPublicDir'].filter(
		(key) => key in http,
	)
	if (forbidden.length === 0) return
	throw new Error(
		`${label} http must not include ${forbidden.map((key) => `"${key}"`).join(', ')}; use top-level "adminAccess" and let the route launcher own management internals.`,
	)
}
