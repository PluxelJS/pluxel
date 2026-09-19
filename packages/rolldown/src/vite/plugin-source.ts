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

export type PluginSourceVitePluginsOptions = {
	root?: string
	sourceSpaces?: PluginSemanticsPluginOptions['sourceSpaces']
	configSource?: false | ConfigSourcePluginOptions
	lintGuard?: false | LintGuardPluginOptions
	/** Vite plugin name for Pluxel source/server resolution and OXC semantics. */
	name?: string
	/**
	 * Selects whether bare package imports may use development/source export conditions.
	 * `distribution` keeps transforms for explicit source while resolving built package exports.
	 */
	packageMode?: 'development' | 'distribution'
}

export type PluginSourceVitePipeline = Readonly<{
	plugins: readonly PluginOption[]
	semantics: Pick<
		PluginSemanticsCollector,
		| 'snapshot'
		| 'definitions'
		| 'classifyDefinitionArtifact'
		| 'beginArtifactGeneration'
		| 'builtDefinitionModules'
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

/** Vite adapter for source transforms that are safe in a long-lived dev server. */
export function pluginSourceVitePlugins(
	options: PluginSourceVitePluginsOptions = {},
): PluginOption[] {
	return [
		...createPluginSourcePlugins(
			options,
			(root) =>
				createPluginSemanticsPlugin({
					root,
					sourceSpaces: options.sourceSpaces,
				}).plugin as Plugin,
		),
		createSourceConfigPlugin(options),
	]
}

function createPluginSourcePlugins(
	options: PluginSourceVitePluginsOptions,
	semantics: (root: string) => Plugin,
): PluginOption[] {
	const plugins: PluginOption[] = [
		PreprocessorDirectives(),
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
			serverOnlyVitePlugin('pluxel-config-source', configSourcePlugin(options.configSource), {
				enforce: 'pre',
			}),
		)
	}
	return plugins
}

/**
 * Concrete source pipeline for a Host that must consume the exact same semantic facts
 * as its Vite transforms. The returned collector is the sole Workbench plan authority.
 */
export function createPluginSourceVitePipeline(
	options: PluginSourceVitePluginsOptions = {},
): PluginSourceVitePipeline {
	let collector: PluginSemanticsCollector | undefined
	let collectorRoot: string | undefined
	const createSemantics = (root: string): Plugin => {
		if (collector) {
			if (collectorRoot !== root) {
				throw new Error(
					`[pluxel:plugin-source] one source pipeline cannot span Vite roots ${collectorRoot} and ${root}`,
				)
			}
			return collector.plugin as Plugin
		}
		collectorRoot = root
		collector = createPluginSemanticsPlugin({
			root,
			sourceSpaces: options.sourceSpaces,
		})
		return collector.plugin as Plugin
	}
	if (options.root !== undefined) createSemantics(options.root)
	const requireCollector = (): PluginSemanticsCollector => {
		if (!collector) {
			throw new Error(
				'[pluxel:plugin-source] semantic facts are unavailable before Vite configures its server environment',
			)
		}
		return collector
	}
	const plugins = [
		...createPluginSourcePlugins(options, createSemantics),
		createSourceConfigPlugin(options),
	]
	const semantics = Object.freeze({
		snapshot: () => requireCollector().snapshot(),
		definitions: () => requireCollector().definitions(),
		classifyDefinitionArtifact: (
			...args: Parameters<PluginSemanticsCollector['classifyDefinitionArtifact']>
		) => requireCollector().classifyDefinitionArtifact(...args),
		beginArtifactGeneration: () => requireCollector().beginArtifactGeneration(),
		builtDefinitionModules: (activeModules: Iterable<string>) =>
			requireCollector().builtDefinitionModules(activeModules),
		workbenchPlans: () => requireCollector().workbenchPlans(),
		workbenchCompilations: () => requireCollector().workbenchCompilations(),
		workbenchContentCompilations: () => requireCollector().workbenchContentCompilations(),
		invalidateWorkbench: () => requireCollector().invalidateWorkbench(),
	})
	return Object.freeze({ plugins: Object.freeze(plugins), semantics })
}

function createSourceConfigPlugin(options: PluginSourceVitePluginsOptions): Plugin {
	const packageConditions =
		options.packageMode === 'distribution'
			? [...PLUXEL_EXTERNAL_RESOLVE_CONDITIONS, 'module', 'browser', 'production']
			: [...PLUXEL_SOURCE_RESOLVE_CONDITIONS]
	const configPlugin: Plugin = {
		name: options.name ?? 'pluxel:plugin-source',
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
					preserveSymlinks: false,
				},
				ssr: {
					...(options.packageMode === 'distribution' ? {} : { noExternal: true }),
					external: options.packageMode === 'distribution' ? true : [],
					resolve: {
						conditions: packageConditions,
						externalConditions: [...PLUXEL_EXTERNAL_RESOLVE_CONDITIONS],
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
