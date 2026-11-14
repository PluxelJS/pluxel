import type { InlineConfig, TsdownPlugin, TsdownPluginOption } from 'vite-plus/pack'
import { dirname, relative, resolve } from 'node:path'
import Macros from 'unplugin-macros/rolldown'
import PreprocessorDirectives from 'unplugin-preprocessor-directives/rollup'
import { configSourcePlugin } from '../rolldown/plugins/configSourcePlugin'
import { lintGuardPlugin } from '../rolldown/plugins/lintGuardPlugin'
import { parseStandaloneWithLang } from '../rolldown/plugins/pluginUtils'
import { pluginArtifactBuildPlugin } from '../plugin-artifact/pluginArtifactBuildPlugin'
import { createPluginSemanticsPlugin } from '../rolldown/plugins/pluginSemanticsPlugin'
import { collectTinybaseConsumers } from './tinybase-peer'
import { createPluginDependencyMetadataHook } from './plugin-metadata'
import type { BuildLogger } from './types'
import type { OutputChunk, Plugin } from 'rolldown'
import { createPluginControlPlugin } from '../control/plugin'
import { addControlExport, controlEntry } from './control-exports'

type TsdownInputOptions = Exclude<
	NonNullable<InlineConfig['inputOptions']>,
	(...args: any[]) => unknown
>
type TsdownTransformOptions = NonNullable<TsdownInputOptions['transform']>

export type PluginBuildPipelineOptions = {
	root: string
	lint?: boolean
	artifactBuildDir?: string
	node?: {
		minify?: boolean
		/** @internal Standalone deployment root owning traced native dependencies. */
		nativeDependencyRoot?: string
		/** @internal Static applications use this to trace native worker artifacts. */
		onNativeResidual?: (name: string, resolvedEntry: string) => void
		/** @internal Static applications clear native worker facts between generations. */
		onNativeResidualReset?: () => void
	}
	workbench?:
		| false
		| {
				buildDir?: string
				minify?: boolean
		  }
	additionalPlugins?: InlineConfig['plugins']
}

export type PluginPackageOptions = PluginBuildPipelineOptions & {
	packageMetadata: {
		packageJsonPath: string
		log: BuildLogger
	}
}

export type PluginBuildPipeline = {
	plugins: TsdownPluginOption[]
	inputOptions: TsdownInputOptions
	/** Exact compiler facts used by application output ownership. */
	semantics: ReturnType<typeof createPluginSemanticsPlugin>
}

/**
 * Shared production compiler semantics for plugin sources.
 *
 * Output topology remains the caller's responsibility: plugin packages keep runtime peers
 * external, while static applications add their deployment closure and assembly plugins.
 */
export function createPluginBuildPipeline(
	options: PluginBuildPipelineOptions,
	selectWorkbenchDefinitions?: () => ReadonlySet<string>,
): PluginBuildPipeline {
	const semantics = createPluginSemanticsPlugin({ root: options.root })
	return createPipeline(options, semantics, selectWorkbenchDefinitions)
}

function createPipeline(
	options: PluginBuildPipelineOptions,
	semantics: ReturnType<typeof createPluginSemanticsPlugin>,
	selectWorkbenchDefinitions?: () => ReadonlySet<string>,
): PluginBuildPipeline {
	const workbench = options.workbench ?? {}
	const workbenchOptions = workbench === false ? {} : workbench
	return {
		semantics,
		plugins: [
			PreprocessorDirectives(),
			semantics.plugin,
			Macros(),
			options.lint === false ? undefined : lintGuardPlugin({ cwd: options.root }),
			configSourcePlugin(),
			createPluginControlPlugin({
				root: options.root,
				semantics,
				typeImports: 'packageMetadata' in options ? 'package' : 'closure',
			}),
			pluginArtifactBuildPlugin({
				root: options.root,
				buildDir: options.artifactBuildDir ?? workbenchOptions.buildDir,
				workbench:
					workbench === false
						? false
						: {
								minify: workbenchOptions.minify,
								compilations: () => semantics.workbenchCompilations(selectWorkbenchDefinitions?.()),
								contentCompilations: () =>
									semantics.workbenchContentCompilations(selectWorkbenchDefinitions?.()),
							},
				node: options.node,
			}),
			...toPluginArray(options.additionalPlugins),
			decoratorOutputGuardPlugin(),
		],
		inputOptions: {
			transform: createPluginTransformOptions(),
		},
	}
}

/** Standard tsdown overlay for independently published plugin packages. */
export function pluginPackage(
	options: PluginPackageOptions,
): Omit<InlineConfig, 'inputOptions' | 'plugins'> & Omit<PluginBuildPipeline, 'semantics'> {
	const semantics = createPluginSemanticsPlugin({
		root: options.root,
		packageJsonPath: options.packageMetadata.packageJsonPath,
	})
	const { semantics: _collector, ...pipeline } = createPipeline(options, semantics)
	const tinybase = collectTinybaseConsumers(options.packageMetadata.packageJsonPath)
	pipeline.plugins.unshift(pluginControlExportsPlugin(options), tinybase.plugin)
	return {
		exports: {
			// Keep linked development packages on the HMR source condition without exposing raw TS
			// through the generic @pluxel/source condition.
			devExports: '@pluxel/hmr',
		},
		deps: {
			neverBundle: [/^@pluxel\//, /^tinybase(?:\/|$)/],
		},
		...pipeline,
		onSuccess: createPluginDependencyMetadataHook({
			packageJsonPath: options.packageMetadata.packageJsonPath,
			workbenchArtifacts: options.workbench !== false,
			log: options.packageMetadata.log,
			collectPlugins: () => semantics.snapshot(),
			collectTinybaseConsumers: tinybase.usesTinybase,
			collectWorkbenchTargets: async () => {
				const targets = await semantics.workbenchCompilations()
				return targets.length > 0
			},
		}),
	}
}

/** Register the generated asset in tsdown's own writeback, after author export customization. */
function pluginControlExportsPlugin(options: PluginPackageOptions): TsdownPlugin {
	return {
		name: 'pluxel:plugin-control-exports',
		tsdownConfig(config) {
			if (!config.exports) return
			const exportsOptions =
				typeof config.exports === 'object' ? config.exports : { enabled: config.exports }
			const customExports = exportsOptions.customExports
			const outDir = resolve(config.cwd ?? options.root, config.outDir ?? 'dist')
			const artifactRoot = relative(
				dirname(options.packageMetadata.packageJsonPath),
				outDir,
			).replaceAll('\\', '/')
			const entry = controlEntry(artifactRoot ? `./${artifactRoot}/control` : './control')
			config.exports = {
				...exportsOptions,
				async customExports(exports, context) {
					const field = context.isPublish ? 'publishConfig.exports' : 'exports'
					const original = context.isPublish
						? context.pkg.publishConfig?.exports
						: context.pkg.exports
					const marker = context.pkg.pluxel?.control
					// Check ownership before tsdown discards the previous generated export map.
					addControlExport(original, entry, marker, field)
					const authored =
						typeof customExports === 'function'
							? await customExports(exports, context)
							: { ...exports, ...customExports }
					return addControlExport(authored, entry, marker, field)
				},
			}
		},
	}
}

function createPluginTransformOptions(): TsdownTransformOptions {
	return {
		assumptions: {
			setPublicClassFields: true,
		},
		decorator: {
			legacy: true,
			emitDecoratorMetadata: false,
		},
		typescript: {
			removeClassFieldsWithoutInitializer: true,
		},
	}
}

function decoratorOutputGuardPlugin(): Plugin {
	return {
		name: 'pluxel:decorator-output-guard',
		generateBundle(_, bundle) {
			for (const item of Object.values(bundle)) {
				if (item.type !== 'chunk') continue
				assertNoUnloweredDecorators(this, item)
			}
		},
	}
}

function assertNoUnloweredDecorators(
	context: { error(message: string): never },
	chunk: OutputChunk,
): void {
	const ast = parseStandaloneWithLang(chunk.code, chunk.fileName)
	if (!ast) context.error(`[pluxel:build] failed to validate generated chunk ${chunk.fileName}`)
	if (hasUnloweredDecorators(ast)) {
		context.error(
			`[pluxel:build] generated chunk ${chunk.fileName} still contains decorator syntax; Pluxel plugin sources must use the shared legacy decorator transform`,
		)
	}
}

function hasUnloweredDecorators(value: unknown): boolean {
	if (!value || typeof value !== 'object') return false
	if (Array.isArray(value)) return value.some(hasUnloweredDecorators)
	const node = value as Record<string, unknown>
	if (Array.isArray(node.decorators) && node.decorators.length > 0) return true
	return Object.values(node).some(hasUnloweredDecorators)
}

function toPluginArray(plugins: InlineConfig['plugins']): TsdownPluginOption[] {
	if (!plugins) return []
	return Array.isArray(plugins) ? plugins : [plugins]
}
