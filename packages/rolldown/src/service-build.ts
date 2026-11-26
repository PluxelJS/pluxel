import { createHash } from 'node:crypto'
import * as contracts from '@pluxel/core/internal/control-manifest'
import { formatPluginDefinitionReference, pluginDefinitionIndexKey } from '@pluxel/core'
import MagicString from 'magic-string'
import type { TsdownPlugin } from 'vite-plus/pack'
import { generateControl } from './control/generate'
import {
	lowerServiceModule,
	serviceSourceEntry,
	type ServiceSemanticDefinition,
} from './service-semantics'

/** Build declarations and control materials for packages that install application services. */
export function createServiceBuildPlugin(options: {
	root: string
	controlDirectory?: string
}): TsdownPlugin {
	const sources = new Map<string, string>(),
		definitions = new Map<string, ServiceSemanticDefinition>()
	let tsconfig: string | false | undefined
	return {
		name: 'pluxel:service-build',
		tsdownConfigResolved(config) {
			tsconfig = config.tsconfig
		},
		buildStart() {
			sources.clear()
			definitions.clear()
		},
		async transform(code, id) {
			if (
				id.includes('node_modules') ||
				!/\.[cm]?[jt]sx?$/.test(id) ||
				!/\b(?:defineServiceRef|installRootService|installScopeService|installOwnerViewService)\b/.test(
					code,
				)
			)
				return null
			const lowered = await lowerServiceModule({
				code,
				id,
				resolve: async (source) => {
					const resolved = await this.resolve(source, id, { skipSelf: true })
					return resolved?.id
				},
				canonicalSourceEntry: (sourceId) => serviceSourceEntry(options.root, sourceId),
				controlContracts: contracts,
				error: (message) => this.error(message),
			})
			sources.set(id, code)
			for (const definition of lowered.services)
				definitions.set(JSON.stringify(definition.definition), definition)
			if (lowered.replacements.length === 0) return null
			const output = new MagicString(code)
			for (const replacement of lowered.replacements)
				output.overwrite(replacement.start, replacement.end, replacement.text)
			const imports = [
				lowered.hasDefinitions
					? '__defineServiceDefinition as __pluxelDefineServiceDefinition'
					: undefined,
				lowered.hasRefs ? '__defineServiceRef as __pluxelDefineServiceRef' : undefined,
			].filter(Boolean)
			output.prepend(`import { ${imports.join(', ')} } from '@pluxel/core/toolchain';\n`)
			return { code: output.toString(), map: output.generateMap({ hires: true }) }
		},
		generateBundle: {
			order: 'pre',
			async handler() {
				const services = [...definitions.values()].filter(
					(source) => source.definition.entry.kind !== 'source-entry',
				)
				if (services.length === 0)
					this.error(
						'[pluxel:service-build] Package does not install any public Service declaration',
					)
				const generation = await generateControl({
					contracts: {
						...contracts,
						formatPluginDefinitionReference,
						pluginDefinitionIndexKey,
						controlSha256: (source) => createHash('sha256').update(source).digest('hex'),
					},
					root: options.root,
					tsconfig,
					definitions: [],
					services,
					sources,
					typeImports: 'package',
				})
				for (const path of Object.keys(generation.inputs)) this.addWatchFile(path)
				for (const [path, source] of Object.entries(generation.files))
					this.emitFile({
						type: 'asset',
						fileName: `${options.controlDirectory ?? 'control'}/${path}`,
						source,
					})
			},
		},
	}
}
