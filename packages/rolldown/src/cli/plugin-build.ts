import type { InlineConfig } from 'tsdown'
import Macros from 'unplugin-macros/rolldown'
import PreprocessorDirectives from 'unplugin-preprocessor-directives/rollup'
import { configSourcePlugin } from '../rolldown/plugins/configSourcePlugin'
import { lintGuardPlugin } from '../rolldown/plugins/lintGuardPlugin'
import { parseStandaloneWithLang } from '../rolldown/plugins/pluginUtils'
import { workbenchUiBuildPlugin } from '../rolldown/plugins/workbenchUiBuildPlugin'
import { createPluginSemanticsPlugin } from '../rolldown/plugins/pluginSemanticsPlugin'
import { createPluginDependencyMetadataHook } from './plugin-metadata'
import type { BuildLogger } from './types'
import type { OutputChunk, Plugin } from 'rolldown'

type TsdownInputOptions = NonNullable<InlineConfig['inputOptions']>
type TsdownTransformOptions = NonNullable<TsdownInputOptions['transform']>

export type PluginBuildPipelineOptions = {
	root: string
	lint?: boolean
	workbench?:
		| false
		| {
				buildDir?: string
				minify?: boolean
		  }
	additionalPlugins?: InlineConfig['plugins']
}

export type PluginPackageOptions = PluginBuildPipelineOptions & {
	packageMetadata?: {
		packageJsonPath: string
		manifestField: string
		prefixes: string[]
		log: BuildLogger
	}
}

export type PluginBuildPipeline = Pick<InlineConfig, 'plugins' | 'inputOptions'>

/**
 * Shared production compiler semantics for plugin sources.
 *
 * Output topology remains the caller's responsibility: plugin packages keep runtime peers
 * external, while static applications add their deployment closure and assembly plugins.
 */
export function createPluginBuildPipeline(
	options: PluginBuildPipelineOptions,
): PluginBuildPipeline {
	return createPipeline(options, createPluginSemanticsPlugin().plugin)
}

function createPipeline(
	options: PluginBuildPipelineOptions,
	semanticsPlugin: InlineConfig['plugins'],
): PluginBuildPipeline {
	const workbench = options.workbench ?? {}
	return {
		plugins: [
			PreprocessorDirectives(),
			semanticsPlugin,
			Macros({
				viteConfig: {
					configFile: false,
					root: options.root,
				},
			}),
			options.lint === false ? undefined : lintGuardPlugin({ cwd: options.root }),
			configSourcePlugin(),
			workbench === false
				? undefined
				: workbenchUiBuildPlugin({ root: options.root, ...workbench }),
			...toPluginArray(options.additionalPlugins),
			decoratorOutputGuardPlugin(),
		],
		inputOptions: {
			transform: createPluginTransformOptions(),
		},
	}
}

/** Standard tsdown overlay for independently published plugin packages. */
export function pluginPackage(options: PluginPackageOptions): InlineConfig {
	const semantics = createPluginSemanticsPlugin({
		prefixes: options.packageMetadata?.prefixes,
		optionalImportMode: 'external',
	})
	return {
		exports: {
			// Keep linked development packages on the dynamic source condition without exposing raw TS
			// through the generic @pluxel/source condition.
			devExports: '@pluxel/runtime-dynamic',
		},
		deps: {
			neverBundle: [/^@pluxel\//],
		},
		...createPipeline(options, semantics.plugin),
		...(options.packageMetadata
			? {
					onSuccess: createPluginDependencyMetadataHook({
						packageJsonPath: options.packageMetadata.packageJsonPath,
						manifestField: options.packageMetadata.manifestField,
						log: options.packageMetadata.log,
						collectPlugins: () => semantics.snapshot(),
					}),
				}
			: {}),
	}
}

function createPluginTransformOptions(): TsdownTransformOptions {
	return {
		assumptions: {
			setPublicClassFields: true,
		},
		decorator: {
			legacy: true,
			emitDecoratorMetadata: true,
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

function toPluginArray(plugins: InlineConfig['plugins']): unknown[] {
	if (!plugins) return []
	return Array.isArray(plugins) ? plugins : [plugins]
}
