import PreprocessorDirectives from 'unplugin-preprocessor-directives/vite'
import type { Plugin, PluginOption } from 'vite'
import {
	configSourcePlugin,
	type ConfigSourcePluginOptions,
} from '../rolldown/plugins/configSourcePlugin'
import { lintGuardPlugin, type LintGuardPluginOptions } from '../rolldown/plugins/lintGuardPlugin'
import { serverOnlyVitePlugin } from './environment'
import { createPluginSemanticsPlugin } from '../rolldown/plugins/pluginSemanticsPlugin'
import { databaseSourceVitePlugin } from './database-source'
import { PLUXEL_UI_DEDUPE_PACKAGES } from '../workspace/vite'

export type PluginSourceVitePluginsOptions = {
	root?: string
	configSource?: false | ConfigSourcePluginOptions
	lintGuard?: false | LintGuardPluginOptions
}

const PLUXEL_SOURCE_RESOLVE_CONDITIONS = [
	// Plugin packages use a dedicated dev export so their generated manifests do
	// not expose raw TypeScript through the framework-only source condition.
	'@pluxel/hmr',
	// Framework-neutral packages use Node's community development condition.
	'development',
	'@pluxel/source',
	'node',
	'import',
	'module',
	'browser',
	'production',
	'default',
] as const

const PLUXEL_EXTERNAL_RESOLVE_CONDITIONS = ['node', 'import', 'default'] as const

const PLUXEL_SINGLETON_PACKAGES = [
	'@pluxel/runtime',
	'@pluxel/runtime-dev',
	'@pluxel/runtime-dynamic',
	'@pluxel/runtime-static',
	'drizzle-orm',
] as const

// Browser UI singletons are part of the Pluxel host boundary. Keep them in
// the shared source preset so static and dynamic projects do not each have to
// repeat the same Module Federation dedupe configuration.
const PLUXEL_RUNTIME_UI_DEDUPE_PACKAGES = [
	...PLUXEL_SINGLETON_PACKAGES,
	...PLUXEL_UI_DEDUPE_PACKAGES,
] as const

const PLUXEL_SSR_EXTERNAL_PACKAGES = [
	'@pluxel/core',
	'@pluxel/runtime',
	'@pluxel/runtime-dev',
	'@pluxel/runtime-static',
] as const

export type PluxelRuntimeSourceVitePluginsOptions = PluginSourceVitePluginsOptions & {
	/** Vite plugin name for Pluxel source/server resolution and OXC semantics. */
	name?: string
	/**
	 * Selects whether bare package imports may use development/source export conditions.
	 * `distribution` keeps transforms for explicit source while resolving built package exports.
	 */
	packageMode?: 'development' | 'distribution'
}

/** Vite adapter for source transforms that are safe in a long-lived dev server. */
export function pluginSourceVitePlugins(
	options: PluginSourceVitePluginsOptions = {},
): PluginOption[] {
	const root = options.root ?? process.cwd()
	const plugins: PluginOption[] = [
		PreprocessorDirectives(),
		serverOnlyVitePlugin('pluxel:database-source', databaseSourceVitePlugin({ root }), {
			enforce: 'pre',
		}),
		serverOnlyVitePlugin('pluxel:plugin-semantics', createPluginSemanticsPlugin().plugin, {
			enforce: 'pre',
		}),
	]
	if (options.lintGuard !== false) {
		plugins.push(
			serverOnlyVitePlugin(
				'pluxel-lint-guard',
				lintGuardPlugin({
					cwd: root,
					...options.lintGuard,
				}),
				{ enforce: 'pre' },
			),
		)
	}
	if (options.configSource !== false) {
		plugins.push(
			serverOnlyVitePlugin('pluxel-config-source', configSourcePlugin(options.configSource ?? {}), {
				enforce: 'pre',
			}),
		)
	}
	return plugins
}

/** Complete Vite source preset consumed by both static and dynamic runtime routes. */
export function pluxelRuntimeSourceVitePlugins(
	options: PluxelRuntimeSourceVitePluginsOptions = {},
): PluginOption[] {
	const packageConditions =
		options.packageMode === 'distribution'
			? [...PLUXEL_EXTERNAL_RESOLVE_CONDITIONS, 'module', 'browser', 'production']
			: [...PLUXEL_SOURCE_RESOLVE_CONDITIONS]
	const externalPackages =
		options.packageMode === 'distribution' ? true : [...PLUXEL_SSR_EXTERNAL_PACKAGES]
	const configPlugin: Plugin = {
		name: options.name ?? 'pluxel:runtime-source',
		config(config) {
			return {
				...(config.server?.watch === null
					? {}
					: {
							server: {
								watch: {
									// Generated package proxies and artifacts are not application source.
									// Keep ignoring them, including stale v1 whole-checkout links.
									ignored: ['**/.pluxel/**'],
								},
							},
						}),
				resolve: {
					conditions: packageConditions,
					externalConditions: [...PLUXEL_EXTERNAL_RESOLVE_CONDITIONS],
					dedupe: [...PLUXEL_RUNTIME_UI_DEDUPE_PACKAGES],
					preserveSymlinks: false,
				},
				ssr: {
					external: externalPackages,
					resolve: {
						conditions: packageConditions,
						externalConditions: [...PLUXEL_EXTERNAL_RESOLVE_CONDITIONS],
						dedupe: [...PLUXEL_RUNTIME_UI_DEDUPE_PACKAGES],
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
	return [...pluginSourceVitePlugins(options), configPlugin]
}
