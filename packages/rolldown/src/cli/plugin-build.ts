import type { InlineConfig, TsdownPluginOption } from 'tsdown'
import Macros from 'unplugin-macros/rolldown'
import PreprocessorDirectives from 'unplugin-preprocessor-directives/rollup'
import { configSourcePlugin } from '../rolldown/plugins/configSourcePlugin'
import { lintGuardPlugin } from '../rolldown/plugins/lintGuardPlugin'
import { parseStandaloneWithLang } from '../rolldown/plugins/pluginUtils'
import { pluginArtifactBuildPlugin } from '../plugin-artifact/pluginArtifactBuildPlugin'
import { createPluginSemanticsPlugin } from '../rolldown/plugins/pluginSemanticsPlugin'
import { createPluginDependencyMetadataHook } from './plugin-metadata'
import type { BuildLogger } from './types'
import type { OutputChunk, Plugin } from 'rolldown'

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
		manifestField: string
		log: BuildLogger
	}
}

export type PluginBuildPipeline = {
	plugins: TsdownPluginOption[]
	inputOptions: TsdownInputOptions
}

/**
 * Shared production compiler semantics for plugin sources.
 *
 * Output topology remains the caller's responsibility: plugin packages keep runtime peers
 * external, while static applications add their deployment closure and assembly plugins.
 */
export function createPluginBuildPipeline(
	options: PluginBuildPipelineOptions,
): PluginBuildPipeline {
	const semantics = createPluginSemanticsPlugin({ root: options.root })
	return createPipeline(options, semantics)
}

function createPipeline(
	options: PluginBuildPipelineOptions,
	semantics: ReturnType<typeof createPluginSemanticsPlugin>,
): PluginBuildPipeline {
	const workbench = options.workbench ?? {}
	const workbenchOptions = workbench === false ? {} : workbench
	return {
		plugins: [
			PreprocessorDirectives(),
			semantics.plugin,
			Macros({
				viteConfig: {
					configFile: false,
					root: options.root,
				},
			}),
			options.lint === false ? undefined : lintGuardPlugin({ cwd: options.root }),
			configSourcePlugin(),
			pluginArtifactBuildPlugin({
				root: options.root,
				buildDir: options.artifactBuildDir ?? workbenchOptions.buildDir,
				workbench:
					workbench === false
						? false
						: {
								minify: workbenchOptions.minify,
								compilations: () => semantics.workbenchCompilations(),
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
): Omit<InlineConfig, 'inputOptions' | 'plugins'> & PluginBuildPipeline {
	const semantics = createPluginSemanticsPlugin({
		root: options.root,
		packageJsonPath: options.packageMetadata.packageJsonPath,
	})
	return {
		exports: {
			// Keep linked development packages on the HMR source condition without exposing raw TS
			// through the generic @pluxel/source condition.
			devExports: '@pluxel/hmr',
		},
		deps: {
			neverBundle: [/^@pluxel\//],
		},
		...createPipeline(options, semantics),
		onSuccess: createPluginDependencyMetadataHook({
			packageJsonPath: options.packageMetadata.packageJsonPath,
			manifestField: options.packageMetadata.manifestField,
			log: options.packageMetadata.log,
			collectPlugins: () => semantics.snapshot(),
		}),
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
