import type { StaticRuntimeConfig } from './types'

const STATIC_RUNTIME_CONFIG_MARKER = Symbol.for('pluxel.staticRuntimeConfig')

type MarkedStaticRuntimeConfig = StaticRuntimeConfig & {
	readonly [STATIC_RUNTIME_CONFIG_MARKER]?: true
}

export function defineStaticRuntimeConfig<T extends StaticRuntimeConfig>(config: T): T {
	if ('vite' in config) {
		throw new Error(
			'[runtime-static] Static runtime config must not include a nested "vite" field; use the host vite.config.ts instead',
		)
	}
	if ('hmr' in config) {
		throw new Error(
			'[runtime-static] Static runtime config must not include an "hmr" field; pass staticRuntimeVitePlugin({ hmr }) options from the host vite.config.ts instead',
		)
	}
	assertPublicHttpConfig(config.http, '[runtime-static] Static runtime config')
	Object.defineProperty(config, STATIC_RUNTIME_CONFIG_MARKER, {
		value: true,
		enumerable: false,
		configurable: false,
	})
	return config
}

export function isStaticRuntimeConfig(value: unknown): value is StaticRuntimeConfig {
	return Boolean(
		value &&
		typeof value === 'object' &&
		(value as MarkedStaticRuntimeConfig)[STATIC_RUNTIME_CONFIG_MARKER] === true,
	)
}

function assertPublicHttpConfig(http: unknown, label: string): void {
	if (!http || typeof http !== 'object') return
	const forbidden = ['management', 'controlPlane', 'uiAssets', 'uiPublicDir'].filter(
		(key) => key in http,
	)
	if (forbidden.length === 0) return
	throw new Error(
		`${label} http must not include ${forbidden.map((key) => `"${key}"`).join(', ')}; use top-level "webManagement" and let the route launcher own management internals.`,
	)
}
