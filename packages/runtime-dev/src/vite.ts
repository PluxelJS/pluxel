import {
	configSourcePlugin,
	lintGuardPlugin,
	runtimeUiBridgePlugin,
	type ConfigSourcePluginOptions,
	type LintGuardPluginOptions,
	type RuntimeUiBridgePluginOptions,
} from '@pluxel/rolldown/plugins'
import { isServerConsumerEnvironment } from '@pluxel/rolldown/vite'
import { perEnvironmentPlugin, type Plugin, type PluginOption } from 'vite'

const PLUXEL_SOURCE_RESOLVE_CONDITIONS = [
	'@pluxel/source',
	'node',
	'import',
	'module',
	'browser',
	'development',
	'production',
	'default',
] as const

const PLUXEL_EXTERNAL_RESOLVE_CONDITIONS = [
	'node',
	'import',
	'module',
	'browser',
	'development',
	'production',
	'default',
] as const

const PLUXEL_SINGLETON_PACKAGES = [
	'@pluxel/context',
	'@pluxel/core',
	'@pluxel/runtime',
	'@pluxel/runtime-dev',
	'@pluxel/runtime-dynamic',
	'@pluxel/runtime-static',
] as const

export type PluxelRuntimeSourceVitePluginOptions = {
	/**
	 * Vite plugin name for Pluxel source/server semantics.
	 */
	name?: string
	/**
	 * Project root used by lintGuardPlugin. Defaults to process.cwd().
	 */
	root?: string
	/**
	 * Internal Vite plugin name for the server-only source transform group.
	 */
	serverOnlyName?: string
	configSource?: false | ConfigSourcePluginOptions
	lintGuard?: false | LintGuardPluginOptions
}

export type PluxelRuntimeUiBridgeVitePluginOptions = RuntimeUiBridgePluginOptions

export function pluxelRuntimeSourceVitePlugin(
	options: PluxelRuntimeSourceVitePluginOptions = {},
): Plugin {
	const name = options.name ?? 'pluxel:runtime-source'
	const base = perEnvironmentPlugin(name, (environment) => {
		if (!isServerConsumerEnvironment(environment)) return false

		const serverPlugins = createServerSourcePlugins(options)
		if (serverPlugins.length === 0) return false

		return [
			{
				name: options.serverOnlyName ?? 'pluxel:runtime-source-transform',
				enforce: 'pre',
			},
			...serverPlugins,
		]
	})

	return {
		...base,
		// Pluxel plugin classes rely on legacy decorators, and config source
		// extraction runs only in server-like Vite environments.
		config() {
			return {
				resolve: {
					conditions: [...PLUXEL_SOURCE_RESOLVE_CONDITIONS],
					externalConditions: [...PLUXEL_EXTERNAL_RESOLVE_CONDITIONS],
					dedupe: [...PLUXEL_SINGLETON_PACKAGES],
					preserveSymlinks: false,
				},
				environments: {
					ssr: {
						resolve: {
							conditions: [...PLUXEL_SOURCE_RESOLVE_CONDITIONS],
							externalConditions: [...PLUXEL_EXTERNAL_RESOLVE_CONDITIONS],
							dedupe: [...PLUXEL_SINGLETON_PACKAGES],
							preserveSymlinks: false,
						},
					},
				},
				ssr: {
					external: [...PLUXEL_SINGLETON_PACKAGES],
					resolve: {
						conditions: [...PLUXEL_SOURCE_RESOLVE_CONDITIONS],
						externalConditions: [...PLUXEL_EXTERNAL_RESOLVE_CONDITIONS],
						dedupe: [...PLUXEL_SINGLETON_PACKAGES],
						preserveSymlinks: false,
					},
				},
				oxc: {
					decorator: {
						legacy: true,
					},
				},
			}
		},
	}
}

export function pluxelRuntimeUiBridgeVitePlugin(
	options: PluxelRuntimeUiBridgeVitePluginOptions = {},
): PluginOption {
	return runtimeUiBridgePlugin(options)
}

function createServerSourcePlugins(options: PluxelRuntimeSourceVitePluginOptions): PluginOption[] {
	const serverPlugins: PluginOption[] = []

	if (options.lintGuard !== false) {
		serverPlugins.push(
			lintGuardPlugin({
				cwd: options.root,
				...options.lintGuard,
			}),
		)
	}
	if (options.configSource !== false)
		serverPlugins.push(configSourcePlugin(options.configSource ?? {}))

	return serverPlugins
}
