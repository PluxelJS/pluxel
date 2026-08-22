import {
	formatPluginNodeReference,
	pluginDefinitionIndexKey,
	type PluginConstructor,
	type PluginNodeAddress,
} from '@pluxel/core'
import {
	consumePluginDefinitionCandidate,
	type ConcretePluginDefinitionCandidate,
} from '@pluxel/core/internal'
import {
	createPluginRouteCatalogSnapshot,
	type PluginRouteCatalogProvenance,
	type PluginRouteCatalogSnapshot,
} from '@pluxel/runtime/internal'

export type ModuleId = string
export type ExportKey = string

type DraftItem = Readonly<{
	candidate: ConcretePluginDefinitionCandidate
	moduleId: ModuleId
	provenance: PluginRouteCatalogProvenance
}>

export interface PluginCatalogDraft {
	readonly baseRevision: number
	declarePlugin(
		moduleId: ModuleId,
		implementation: PluginConstructor,
		exportKey?: ExportKey,
	): PluginNodeAddress
	undeclareModule(moduleId: ModuleId): void
	commitSnapshot(): PluginRouteCatalogSnapshot
	rollback(): void
}

/**
 * Builds one private dynamic-route catalog candidate from the committed common snapshot.
 *
 * The draft owns only batch-local mutable indexes. Once accepted, the coordinator snapshot is the
 * sole committed catalog; no route registry or publication callback exists after the transaction.
 */
export function createPluginCatalogDraft(base: PluginRouteCatalogSnapshot): PluginCatalogDraft {
	return new PluginCatalogDraftImpl(base)
}

class PluginCatalogDraftImpl implements PluginCatalogDraft {
	public readonly baseRevision: number
	private readonly items = new Map<string, DraftItem>()
	private readonly definitionsByModule = new Map<ModuleId, Set<string>>()
	private closed = false

	constructor(base: PluginRouteCatalogSnapshot) {
		this.baseRevision = base.revision
		for (const entry of base.entries) {
			const moduleId = entry.provenance.moduleId
			if (!moduleId) {
				throw new Error(
					`[runtime-dynamic] committed Plugin ${formatPluginNodeReference({ definition: entry.address, variant: 'default' })} is missing module provenance`,
				)
			}
			this.addItem(entry.indexKey, {
				candidate: entry.candidate,
				moduleId,
				provenance: entry.provenance,
			})
		}
	}

	declarePlugin(
		moduleId: ModuleId,
		implementation: PluginConstructor,
		exportKey?: ExportKey,
	): PluginNodeAddress {
		this.assertOpen()
		const candidate = consumePluginDefinitionCandidate(implementation)
		const declaration = candidate.declaration
		const canonicalExportKey = exportKey ?? declaration.address.exportName
		if (canonicalExportKey !== declaration.address.exportName) {
			throw new Error(
				`[runtime-dynamic] Plugin ${declaration.displayName} must be loaded from root export ` +
					`"${declaration.address.exportName}", received "${canonicalExportKey}" from ${moduleId}`,
			)
		}

		const address: PluginNodeAddress = Object.freeze({
			definition: declaration.address,
			variant: 'default',
		})
		const definitionKey = pluginDefinitionIndexKey(declaration.address)
		const previous = this.items.get(definitionKey)
		if (previous) {
			if (previous.moduleId !== moduleId) {
				throw new Error(
					`[runtime-dynamic] Plugin definition ${formatPluginNodeReference(address)} is already ` +
						`owned by ${previous.moduleId}; ${moduleId} cannot claim the same entry/export identity`,
				)
			}
			if (previous.candidate.implementation === implementation) return address
			throw new Error(
				`[runtime-dynamic] Module ${moduleId} declares Plugin definition ` +
					`${formatPluginNodeReference(address)} more than once`,
			)
		}

		this.addItem(definitionKey, {
			candidate,
			moduleId,
			provenance: Object.freeze({ moduleId }),
		})
		return address
	}

	undeclareModule(moduleId: ModuleId): void {
		this.assertOpen()
		for (const definitionKey of this.definitionsByModule.get(moduleId) ?? []) {
			this.items.delete(definitionKey)
		}
		this.definitionsByModule.delete(moduleId)
	}

	commitSnapshot(): PluginRouteCatalogSnapshot {
		this.assertOpen()
		this.closed = true
		return createPluginRouteCatalogSnapshot(
			this.baseRevision + 1,
			[...this.items.values()].map((item) => ({
				candidate: item.candidate,
				provenance: item.provenance,
			})),
		)
	}

	rollback(): void {
		this.closed = true
		this.items.clear()
		this.definitionsByModule.clear()
	}

	private addItem(definitionKey: string, item: DraftItem): void {
		this.items.set(definitionKey, Object.freeze(item))
		const definitions = this.definitionsByModule.get(item.moduleId)
		if (definitions) definitions.add(definitionKey)
		else this.definitionsByModule.set(item.moduleId, new Set([definitionKey]))
	}

	private assertOpen(): void {
		if (this.closed) throw new Error('[runtime-dynamic] route catalog transaction is closed')
	}
}
