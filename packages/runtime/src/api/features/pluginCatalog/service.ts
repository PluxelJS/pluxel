import { pluginDefinitionIndexKey, type Context } from '@pluxel/core'
import { requireRuntimePluginGraphCoordinator } from '../../../internal/reconciliation'
import type {
	PluginCatalogLayoutInput,
	PluginCatalogSection,
	PluginCatalogSnapshot,
} from '../../../web/protocol'
import type {
	PluginCatalogLayoutEntry,
	PluginCatalogSectionLayout,
} from '../../../services/management/PluginCatalogLayoutService'
import { portablePluginStatus, projectCommittedPluginCatalog } from '../../usecases/plugins'

export async function readPluginCatalog(ctx: Context): Promise<PluginCatalogSnapshot> {
	const layout = requirePluginCatalogLayout(ctx)
	const pinned = await readPinnedCatalog(ctx)
	const sections = await layout.listSections(pinned.layoutEntries)
	return toSnapshot(pinned, sections)
}

export async function writePluginCatalogLayout(
	ctx: Context,
	input: PluginCatalogLayoutInput,
): Promise<readonly PluginCatalogSection[]> {
	const layout = requirePluginCatalogLayout(ctx)
	const pinned = await readPinnedCatalog(ctx)
	const sections = await layout.updateSections(input.sections, pinned.layoutEntries)
	return sections.map(toSection)
}

function requirePluginCatalogLayout(ctx: Context) {
	const service = ctx.root.pluginCatalogLayout
	if (!service) {
		throw new Error('[pluxel/runtime] Plugin catalog layout requires the management plane')
	}
	return service
}

async function readPinnedCatalog(ctx: Context) {
	return await requireRuntimePluginGraphCoordinator(ctx).readCommitted((view) => {
		const projection = projectCommittedPluginCatalog(ctx, view)
		const layoutEntries: PluginCatalogLayoutEntry[] = projection.entries.map((entry) => {
			const declaration = view.catalog.byDefinition.get(
				pluginDefinitionIndexKey(entry.address.definition),
			)?.candidate.declaration
			return Object.freeze({
				address: entry.address,
				displayName: entry.displayName,
				requires: declaration?.requires ?? [],
				...(declaration?.provides === undefined ? {} : { provides: declaration.provides }),
			})
		})
		return Object.freeze({ projection, layoutEntries: Object.freeze(layoutEntries) })
	})
}

function toSnapshot(
	pinned: Awaited<ReturnType<typeof readPinnedCatalog>>,
	sections: readonly PluginCatalogSectionLayout[],
): PluginCatalogSnapshot {
	return Object.freeze({
		plugins: Object.freeze(pinned.projection.entries.map(portablePluginStatus)),
		sections: Object.freeze(sections.map(toSection)),
		summary: pinned.projection.summary,
	})
}

function toSection(section: PluginCatalogSectionLayout): PluginCatalogSection {
	return Object.freeze({
		sectionId: section.sectionId,
		name: section.name,
		basis: section.basis,
		nodes: Object.freeze([...section.nodes]),
	})
}
