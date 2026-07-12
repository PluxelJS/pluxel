import {
	configSourcePlugin,
	lintGuardPlugin,
	type ConfigSourcePluginOptions,
	type LintGuardPluginOptions,
} from '@pluxel/rolldown/plugins'
import { isServerConsumerEnvironment } from '@pluxel/rolldown/vite'
import {
	createServerModuleRunner,
	perEnvironmentPlugin,
	type Plugin,
	type PluginOption,
	type ViteDevServer,
} from 'vite'
import type { ModuleRunner } from 'vite/module-runner'

const pluxelSsrModuleRunners = new WeakMap<ViteDevServer, ModuleRunner>()
const pluxelSsrModuleRunnerClosePatched = new WeakSet<ViteDevServer>()

export type ImportViteSsrModuleOptions = {
	/**
	 * Clears the Pluxel SSR runner cache before import. Use this for config modules
	 * reloaded from Vite HMR, where stale evaluated exports are more harmful than
	 * re-running the small config graph.
	 */
	fresh?: boolean
}

export async function importViteSsrModule<T = Record<string, unknown>>(
	server: ViteDevServer,
	id: string,
	options: ImportViteSsrModuleOptions = {},
): Promise<T> {
	const runner = getPluxelViteSsrModuleRunner(server)
	if (options.fresh) runner.clearCache()
	return runner.import<T>(id)
}

function getPluxelViteSsrModuleRunner(server: ViteDevServer): ModuleRunner {
	const existing = pluxelSsrModuleRunners.get(server)
	if (existing && !existing.isClosed()) return existing

	const environment = server.environments.ssr
	// Prefer Vite 8's Environment Module Runner over server.ssrLoadModule.
	// The compat loader disables sourcemap interception, while the runner keeps
	// source locations correct for diagnostics such as logger caller capture.
	const runner = createServerModuleRunner(environment, {
		hmr: false,
		sourcemapInterceptor: 'prepareStackTrace',
	})
	pluxelSsrModuleRunners.set(server, runner)
	if (!pluxelSsrModuleRunnerClosePatched.has(server)) {
		pluxelSsrModuleRunnerClosePatched.add(server)
		const close = server.close.bind(server)
		server.close = async () => {
			const current = pluxelSsrModuleRunners.get(server)
			pluxelSsrModuleRunners.delete(server)
			if (current && !current.isClosed()) await current.close()
			await close()
		}
	}
	return runner
}

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
	'@pluxel/core',
	'@pluxel/runtime',
	'@pluxel/runtime-dev',
	'@pluxel/runtime-dynamic',
	'@pluxel/runtime-static',
] as const
const PLUXEL_SSR_EXTERNAL_PACKAGES = [
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
					external: [...PLUXEL_SSR_EXTERNAL_PACKAGES],
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
						emitDecoratorMetadata: true,
					},
				},
			}
		},
	}
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
