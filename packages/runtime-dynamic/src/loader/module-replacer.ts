import type { PluginConstructor } from '@pluxel/core'
import { checkPluginDecorator } from '@pluxel/core/internal'
import type { PluginCatalogDraft } from './PluginCatalogDraft'

export type ReplaceModuleResult = {
	isAnchor: boolean
	/** Core owns the definition-wide dependent closure; routes never scan its graph. */
	affectedModules: readonly string[]
}

type ExportedPlugin = {
	ctor: PluginConstructor
	exportKey: string
}

export class ModuleReplacer {
	async replaceModule(
		draft: PluginCatalogDraft,
		moduleId: string,
		mod: Record<string, unknown>,
	): Promise<ReplaceModuleResult> {
		const exported = collectPluginExports(mod)
		draft.undeclareModule(moduleId)
		for (const item of exported) {
			// Candidate ingestion and root-export validation happen while the route transaction is
			// private. Any failure therefore leaves both the common catalog and Core on the LKG.
			draft.declarePlugin(moduleId, item.ctor, item.exportKey)
		}
		return { isAnchor: exported.length > 0, affectedModules: [] }
	}

	removeModule(draft: PluginCatalogDraft, moduleId: string): ReplaceModuleResult {
		draft.undeclareModule(moduleId)
		return { isAnchor: false, affectedModules: [] }
	}
}

function collectPluginExports(mod: Record<string, unknown>): ExportedPlugin[] {
	const exported: ExportedPlugin[] = []
	for (const exportKey of Object.getOwnPropertyNames(mod)) {
		const value = mod[exportKey]
		if (typeof value !== 'function' || !checkPluginDecorator(value)) continue
		exported.push({ ctor: value as PluginConstructor, exportKey })
	}
	return exported
}
