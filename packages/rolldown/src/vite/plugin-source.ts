import PreprocessorDirectives from 'unplugin-preprocessor-directives/vite'
import type { Plugin, PluginOption } from 'vite'
import {
	configSourcePlugin,
	type ConfigSourcePluginOptions,
} from '../rolldown/plugins/configSourcePlugin'
import { lintGuardPlugin, type LintGuardPluginOptions } from '../rolldown/plugins/lintGuardPlugin'
import { serverOnlyVitePlugin, serverOnlyVitePluginFactory } from './environment'
import {
	createPluginSemanticsPlugin,
	type PluginSemanticsCollector,
	type PluginSemanticsPluginOptions,
} from '../rolldown/plugins/pluginSemanticsPlugin'
import { databaseSourceVitePlugin } from './database-source'
import { PLUXEL_UI_DEDUPE_PACKAGES } from '../workspace/vite'

export type PluginSourceVitePluginsOptions = {
	root?: string
	sourceSpaces?: PluginSemanticsPluginOptions['sourceSpaces']
	configSource?: false | ConfigSourcePluginOptions
	lintGuard?: false | LintGuardPluginOptions
}

export type PluginSourceVitePipeline = Readonly<{
	plugins: readonly PluginOption[]
	semantics: Pick<
		PluginSemanticsCollector,
		| 'snapshot'
		| 'definitions'
		| 'workbenchPlans'
		| 'workbenchCompilations'
		| 'workbenchContentCompilations'
		| 'invalidateWorkbench'
	>
}>

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
	return createPluginSourcePlugins(
		options,
		(root) =>
			createPluginSemanticsPlugin({
				root,
				sourceSpaces: options.sourceSpaces,
			}).plugin as Plugin,
	)
}

function createPluginSourcePlugins(
	options: PluginSourceVitePluginsOptions,
	semantics: (root: string) => Plugin,
): PluginOption[] {
	const plugins: PluginOption[] = [
		PreprocessorDirectives(),
		serverOnlyVitePluginFactory(
			'pluxel:database-source',
			(environment) => databaseSourceVitePlugin({ root: options.root ?? environment.config.root }),
			{ enforce: 'pre' },
		),
		serverOnlyVitePluginFactory(
			'pluxel:plugin-semantics',
			(environment) => semantics(options.root ?? environment.config.root) as Plugin,
			{ enforce: 'pre' },
		),
	]
	if (options.lintGuard !== false) {
		plugins.push(
			serverOnlyVitePluginFactory(
				'pluxel-lint-guard',
				(environment) =>
					lintGuardPlugin({
						cwd: options.root ?? environment.config.root,
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

/**
 * Concrete source pipeline for a runtime route that must consume the exact same semantic facts
 * as its Vite transforms. The returned collector is the sole Workbench plan authority.
 */
export function createPluginSourceVitePipeline(
	options: PluxelRuntimeSourceVitePluginsOptions = {},
): PluginSourceVitePipeline {
	let collector: PluginSemanticsCollector | undefined
	let collectorRoot: string | undefined
	const createSemantics = (root: string): Plugin => {
		if (collector) {
			if (collectorRoot !== root) {
				throw new Error(
					`[pluxel:runtime-source] one source pipeline cannot span Vite roots ${collectorRoot} and ${root}`,
				)
			}
			return collector.plugin as Plugin
		}
		collectorRoot = root
		collector = createPluginSemanticsPlugin({ root, sourceSpaces: options.sourceSpaces })
		return collector.plugin as Plugin
	}
	if (options.root !== undefined) createSemantics(options.root)
	const requireCollector = (): PluginSemanticsCollector => {
		if (!collector) {
			throw new Error(
				'[pluxel:runtime-source] semantic facts are unavailable before Vite configures its server environment',
			)
		}
		return collector
	}
	const plugins = [
		...createPluginSourcePlugins(options, createSemantics),
		createRuntimeSourceConfigPlugin(options),
	]
	const semantics = Object.freeze({
		snapshot: () => requireCollector().snapshot(),
		definitions: () => requireCollector().definitions(),
		workbenchPlans: () => requireCollector().workbenchPlans(),
		workbenchCompilations: () => requireCollector().workbenchCompilations(),
		workbenchContentCompilations: () => requireCollector().workbenchContentCompilations(),
		invalidateWorkbench: () => requireCollector().invalidateWorkbench(),
	})
	return Object.freeze({ plugins: Object.freeze(plugins), semantics })
}

/** Complete Vite source preset consumed by both static and dynamic runtime routes. */
export function pluxelRuntimeSourceVitePlugins(
	options: PluxelRuntimeSourceVitePluginsOptions = {},
): PluginOption[] {
	return [...pluginSourceVitePlugins(options), createRuntimeSourceConfigPlugin(options)]
}

function createRuntimeSourceConfigPlugin(options: PluxelRuntimeSourceVitePluginsOptions): Plugin {
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
						emitDecoratorMetadata: false,
					},
				},
			}
		},
	}
	return configPlugin
}
