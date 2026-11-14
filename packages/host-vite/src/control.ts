import { createHash } from 'node:crypto'
import { pluginDefinitionIndexKey, type PluginConstructor } from '@pluxel/core'
import { readLoadedPluginModule, type PluginControlMetadata } from '@pluxel/host/internal'
import { generatePluginControl } from '@pluxel/rolldown/control'
import type { PluginSourceVitePipeline } from '@pluxel/rolldown/vite'
import { normalizePath, type ViteDevServer } from 'vite'
import { collectHostEvaluatedInputs } from './environment'

export type HostPluginControls = Readonly<{
	metadata: ReadonlyMap<string, PluginControlMetadata>
	dependencies: ReadonlySet<string>
	owners: ReadonlyMap<string, ReadonlySet<string>>
	implementations: ReadonlyMap<string, PluginConstructor>
}>

export const emptyHostPluginControls = (): HostPluginControls => ({
	metadata: new Map(),
	dependencies: new Set(),
	owners: new Map(),
	implementations: new Map(),
})

/** Prepare one control attachment alongside the exact evaluated catalog candidate. */
export async function prepareHostPluginControls(options: {
	server: ViteDevServer
	entry: string
	plugins: readonly PluginConstructor[]
	semantics: PluginSourceVitePipeline['semantics']
	previous: HostPluginControls
}): Promise<HostPluginControls> {
	const selected = new Set(
		options.plugins.map((plugin) => pluginDefinitionIndexKey(plugin.definitionAddress())),
	)
	const sources = options.semantics
		.sourceDefinitions()
		.filter(
			(source) =>
				source.kind === 'plugin' && selected.has(pluginDefinitionIndexKey(source.definition)),
		)
	const metadata = new Map<string, PluginControlMetadata>()
	const implementations = new Map(
		options.plugins.map((plugin) => [pluginDefinitionIndexKey(plugin.definitionAddress()), plugin]),
	)
	for (const plugin of options.plugins) {
		const loaded = readLoadedPluginModule(plugin)
		if (loaded) metadata.set(pluginDefinitionIndexKey(plugin.definitionAddress()), loaded.control)
	}
	if (sources.length === 0)
		return { metadata, dependencies: new Set(), owners: new Map(), implementations }
	try {
		const generation = await generatePluginControl({
			root: options.server.config.root,
			definitions: sources,
			sources: options.semantics.sourceContents(),
		})
		// Directory/file sources are independent ModuleRunner roots. Their constructors need
		// the same evidence as Plugins imported directly by the application factory.
		const evaluated = new Map<string, string>()
		for (const root of new Set([options.entry, ...sources.map((source) => source.moduleId)])) {
			for (const [path, content] of collectHostEvaluatedInputs(options.server, root)) {
				if (evaluated.has(path) && evaluated.get(path) !== content)
					throw new Error(`source_changed: evaluated roots contain different inputs for ${path}`)
				evaluated.set(path, content)
			}
		}
		const hash = (content: string) => createHash('sha256').update(content).digest('hex')
		for (const source of sources) {
			const actual = evaluated.get(normalizePath(source.moduleId))
			if (actual === undefined || hash(actual) !== generation.inputs[source.moduleId])
				throw new Error(
					`source_changed: evaluated Plugin input cannot be matched: ${source.moduleId}`,
				)
		}
		for (const [path, source] of evaluated) {
			const checked = generation.inputs[path]
			if (checked !== undefined && hash(source) !== checked)
				throw new Error(
					`source_changed: cached runtime dependency differs from the declaration program: ${path}`,
				)
		}
		const material = Object.freeze({
			snapshot: generation.snapshot,
			manifest: generation.manifest,
			files: generation.files,
		})
		for (const item of generation.manifest.definitions) {
			const key = pluginDefinitionIndexKey(item.definition)
			const previous = options.previous.metadata.get(key)
			if (
				previous?.state === 'available' &&
				options.previous.implementations.get(key) === implementations.get(key) &&
				(previous.contracts.config !== item.contracts.config ||
					previous.contracts.instance !== item.contracts.instance)
			)
				throw new Error(
					`source_changed: declaration changed without definition replacement: ${key}`,
				)
			metadata.set(
				key,
				Object.freeze({ state: 'available', format: 1, contracts: item.contracts, material }),
			)
		}
		const owners = new Map<string, Set<string>>()
		for (const source of sources) {
			const owner = normalizePath(source.moduleId)
			for (const input of generation.definitionInputs[
				pluginDefinitionIndexKey(source.definition)
			] ?? []) {
				const file = normalizePath(input)
				if (file.includes('/node_modules/')) continue
				let affected = owners.get(file)
				if (!affected) owners.set(file, (affected = new Set()))
				affected.add(owner)
			}
		}
		const dependencies = new Set(owners.keys())
		return { metadata, dependencies, owners, implementations }
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		for (const source of sources)
			metadata.set(
				pluginDefinitionIndexKey(source.definition),
				Object.freeze({
					state: 'unavailable',
					reason: message.includes('source_changed') ? 'source_changed' : 'analysis_failed',
					message,
				}),
			)
		return {
			metadata,
			dependencies: options.previous.dependencies,
			owners: options.previous.owners,
			implementations,
		}
	}
}
