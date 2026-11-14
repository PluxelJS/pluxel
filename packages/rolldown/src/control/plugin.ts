import type { TsdownPlugin } from 'vite-plus/pack'
import { generatePluginControl, type PluginControlGeneration } from './generate.ts'
import type { PluginSemanticsCollector } from '../rolldown/plugins/pluginSemanticsPlugin.ts'
import { pluginDefinitionIndexKey } from '@pluxel/core'

export type PluginControlPluginOptions = Readonly<{
	root: string
	semantics: Pick<PluginSemanticsCollector, 'sourceDefinitions' | 'sourceContents'>
	/** Output directory relative to the build output. @defaultValue 'control' */
	directory?: string
	typeImports?: 'closure' | 'package'
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
				if (sources.length === 0) return
				const generation = await generatePluginControl({
					root: options.root,
					tsconfig,
					definitions: sources,
					sources: options.semantics.sourceContents(),
					typeImports: options.typeImports,
				})
				for (const path of Object.keys(generation.inputs)) this.addWatchFile(path)
				for (const [path, source] of Object.entries(generation.files))
					this.emitFile({ type: 'asset', fileName: `${directory}/${path}`, source })
				options.onGenerated?.(generation)
			},
		},
	}
}
