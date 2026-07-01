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
