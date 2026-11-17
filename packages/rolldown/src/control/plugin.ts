import type { TsdownPlugin } from 'vite-plus/pack'
import { generatePluginControl } from './generate-plugin.ts'
import type { PluginControlGeneration } from './generate.ts'
import type { PluginSemanticsCollector } from '../rolldown/plugins/pluginSemanticsPlugin.ts'
import { pluginDefinitionIndexKey } from '@pluxel/core'
import { collectBundledServiceMaterials, mergeBundledServiceMaterials } from './dependencies'

export type PluginControlPluginOptions = Readonly<{
	root: string
	semantics: Pick<
		PluginSemanticsCollector,
		'sourceDefinitions' | 'serviceDefinitions' | 'sourceContents'
	>
	/** Output directory relative to the build output. @defaultValue 'control' */
	directory?: string
	typeImports?: 'closure' | 'package'
	/** Standalone applications carry native package service contracts into their sidecar. */
	bundleServices?: boolean
	/** Ordinary Rolldown compiler project. tsdown supplies its actual resolved selection. */
	tsconfig?: string | false
	/** Select concrete definitions after application catalog analysis. */
	definitions?: () => ReadonlySet<string>
	/** Called with the immutable verified material produced by this compilation. */
	onGenerated?: (generation: PluginControlGeneration) => void
}>

/** Production compiler integration. Generation failures fail the build before publication. */
export function createPluginControlPlugin(options: PluginControlPluginOptions): TsdownPlugin {
	const directory = options.directory ?? 'control'
	let tsconfig = options.tsconfig
	if (
		!directory ||
		directory.split('/').some((part) => !part || part === '.' || part === '..') ||
		/[\\\0]/.test(directory)
	)
		throw new TypeError('Control output directory must be a safe relative path')
	return {
		name: 'pluxel:plugin-control',
		tsdownConfigResolved(config) {
			tsconfig = config.tsconfig
		},
		generateBundle: {
			order: 'pre',
			async handler() {
				const selected = options.definitions?.()
				const sources = options.semantics
					.sourceDefinitions()
					.filter(
						(source) =>
							source.kind === 'plugin' &&
							(!selected || selected.has(pluginDefinitionIndexKey(source.definition))),
					)
				const services = options.semantics.serviceDefinitions()
				const dependencies = options.bundleServices
					? await collectBundledServiceMaterials(this.getModuleIds())
					: []
				const generated =
					sources.length > 0 || services.length > 0
						? await generatePluginControl({
								root: options.root,
								tsconfig,
								definitions: sources,
								services,
								sources: options.semantics.sourceContents(),
								typeImports: options.typeImports,
							})
						: undefined
				const generation = await mergeBundledServiceMaterials(generated, dependencies)
				if (!generation) return
				for (const path of Object.keys(generation.inputs)) this.addWatchFile(path)
				for (const [path, source] of Object.entries(generation.files))
					this.emitFile({ type: 'asset', fileName: `${directory}/${path}`, source })
				options.onGenerated?.(generation)
			},
		},
	}
}
