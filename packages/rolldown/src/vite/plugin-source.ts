import PreprocessorDirectives from 'unplugin-preprocessor-directives/vite'
import { isBuiltin } from 'node:module'
import {
	defaultClientConditions,
	defaultServerConditions,
	perEnvironmentPlugin,
	type Plugin,
	type PluginOption,
} from 'vite'
import {
	configSourcePlugin,
	type ConfigSourcePluginOptions,
} from '../rolldown/plugins/configSourcePlugin'
import { lintGuardPlugin, type LintGuardPluginOptions } from '../rolldown/plugins/lintGuardPlugin'
import {
	isBrowserConsumerEnvironment,
	serverOnlyVitePlugin,
	serverOnlyVitePluginFactory,
} from './environment'
import {
	createPluginSemanticsPlugin,
	type PluginSemanticsCollector,
	type PluginSemanticsPluginOptions,
} from '../rolldown/plugins/pluginSemanticsPlugin'
import { rpcPublicationPlugin } from '../rolldown/plugins/rpcPublicationPlugin'

export type PluginSourceVitePluginsOptions = {
	root?: string
	sourceSpaces?: PluginSemanticsPluginOptions['sourceSpaces']
	configSource?: false | ConfigSourcePluginOptions
	lintGuard?: false | LintGuardPluginOptions
	/** Vite plugin name for Pluxel source/server resolution and OXC semantics. */
	name?: string
	/**
	 * Selects whether bare package imports may use Pluxel source export conditions.
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
	'@pluxel/source',
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
	environmentName?: string,
): PluginOption[] {
	const preprocessor = PreprocessorDirectives()
	const plugins: PluginOption[] = [
		environmentName
			? {
					...perEnvironmentPlugin('unplugin-preprocessor-directives', (environment) =>
						environment.name === environmentName || isBrowserConsumerEnvironment(environment)
							? preprocessor
							: false,
					),
					enforce: 'pre',
				}
			: preprocessor,
		{
			name: 'pluxel:browser-node-imports',
			enforce: 'pre',
			applyToEnvironment: isBrowserConsumerEnvironment,
			async resolveId(source, importer, resolveOptions) {
				if (!isBuiltin(source)) return null
				// Let Vite and user aliases supply an intentional browser implementation first.
				const resolved = await this.resolve(source, importer, { ...resolveOptions, skipSelf: true })
				if (resolved?.id.startsWith('__vite-browser-external')) {
					this.error(
						`[pluxel] Node-only import ${JSON.stringify(source)} in browser module ${JSON.stringify(importer ?? '<entry>')}; move it to server code or provide a browser implementation.`,
					)
				}
				return resolved
			},
		},
	]
	const serverPlugins: PluginOption[] = [
		serverOnlyVitePlugin('pluxel:rpc-publication', rpcPublicationPlugin(), {
			enforce: 'pre',
			environment: environmentName,
		}),
		serverOnlyVitePluginFactory(
			'pluxel:plugin-semantics',
			(environment) => semantics(options.root ?? environment.config.root) as Plugin,
			{ enforce: 'pre', environment: environmentName },
		),
	]

	if (options.lintGuard !== false) {
		serverPlugins.push(
			serverOnlyVitePluginFactory(
				'pluxel-lint-guard',
				(environment) =>
					lintGuardPlugin({
						cwd: options.root ?? environment.config.root,
						...options.lintGuard,
					}),
				{ enforce: 'pre', environment: environmentName },
			),
		)
	}
	if (options.configSource !== false) {
		serverPlugins.push(
			serverOnlyVitePlugin('pluxel-config-source', configSourcePlugin(options.configSource), {
				enforce: 'pre',
				environment: environmentName,
			}),
		)
	}
	return [...plugins, ...serverPlugins]
}

/**
 * Concrete source pipeline for a Host that must consume the exact same semantic facts
 * as its Vite transforms. The returned collector is the sole Workbench plan authority.
 */
export function createPluginSourceVitePipeline(
	options: PluginSourceVitePluginsOptions & {
		/** The sole server environment owning this pipeline's semantic collector. @default 'ssr' */
		environment?: string
	} = {},
): PluginSourceVitePipeline {
	const environment = options.environment ?? 'ssr'
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
		...createPluginSourcePlugins(options, createSemantics, environment),
		createSourceConfigPlugin(options, environment),
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

function createSourceConfigPlugin(
	options: PluginSourceVitePluginsOptions,
	environment?: string,
): Plugin {
	const sourceConditions: readonly string[] =
		options.packageMode === 'distribution' ? [] : PLUXEL_SOURCE_RESOLVE_CONDITIONS
	const configPlugin: Plugin = {
		name: options.name ?? 'pluxel:plugin-source',
		config(config) {
			const serverResolve = {
				conditions: [...sourceConditions, ...defaultServerConditions],
				externalConditions: [...PLUXEL_EXTERNAL_RESOLVE_CONDITIONS],
				preserveSymlinks: false,
			}
			const external =
				options.packageMode === 'distribution'
					? { external: true as const }
					: { noExternal: true as const, external: [] as string[] }
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
				...(environment
					? {
							resolve: { tsconfigPaths: config.resolve?.tsconfigPaths ?? true },
							environments: {
								client: {
									resolve: { conditions: [...sourceConditions, ...defaultClientConditions] },
								},
								[environment]: {
									consumer: 'server' as const,
									resolve: {
										...serverResolve,
										...external,
									},
								},
							},
						}
					: {
							resolve: {
								tsconfigPaths: config.resolve?.tsconfigPaths ?? true,
								conditions: [...sourceConditions, ...defaultClientConditions],
								externalConditions: [...PLUXEL_EXTERNAL_RESOLVE_CONDITIONS],
								preserveSymlinks: false,
							},
							ssr: { ...external, resolve: serverResolve },
						}),
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
