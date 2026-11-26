import { formatPluginNodeRoute } from '@pluxel/core'
import type { PluginCatalogSection } from '@pluxel/services/management/client'
import type { WorkbenchLayoutEntry } from '@pluxel/workbench/client'

export type PageEntry = WorkbenchLayoutEntry & {
	placement: Exclude<WorkbenchLayoutEntry['placement'], { kind: 'panel' }>
}

type ApplicationSection = {
	key: string
	label?: string
	entries: readonly PageEntry[]
}

export function groupApplicationEntries(
	entries: readonly PageEntry[],
	sections: readonly PluginCatalogSection[] = [],
): ApplicationSection[] {
	if (sections.length === 0) return [{ key: 'ungrouped', entries }]

	const byOwner = new Map<string, PageEntry[]>()
	for (const entry of entries) {
		const route = formatPluginNodeRoute(entry.target.node)
		const owned = byOwner.get(route)
		if (owned) owned.push(entry)
		else byOwner.set(route, [entry])
	}
	const grouped = new Set<string>()
	const result: ApplicationSection[] = []
	for (const section of sections) {
		const pages = section.nodes.flatMap((owner) => {
			const route = formatPluginNodeRoute(owner)
			grouped.add(route)
			return byOwner.get(route) ?? []
		})
		if (pages.length > 0)
			result.push({ key: `catalog:${section.sectionId}`, label: section.name, entries: pages })
	}
	const ungrouped = entries.filter(
		(entry) => !grouped.has(formatPluginNodeRoute(entry.target.node)),
	)
	if (ungrouped.length > 0)
		result.push({
			key: 'ungrouped',
			label: result.length > 0 ? '未分组' : undefined,
			entries: ungrouped,
		})
	return result
}

export function publicationNavigation({ placement, descriptor }: PageEntry) {
	return placement.kind === 'tab'
		? { label: placement.label ?? descriptor.key, group: placement.group }
		: { label: placement.navigation?.label ?? placement.title, group: placement.navigation?.group }
}

export function groupPublicationEntries(entries: readonly PageEntry[]) {
	const groups = new Map<string, { label: string; explicit: boolean; entries: PageEntry[] }>()
	for (const entry of entries) {
		const { group } = publicationNavigation(entry)
		const key = JSON.stringify([formatPluginNodeRoute(entry.target.node), group?.id ?? null])
		let section = groups.get(key)
		if (!section) {
			section = {
				label: [entry.target.displayName, group?.label].filter(Boolean).join(' · '),
				explicit: !!group,
				entries: [],
			}
			groups.set(key, section)
		}
		section.entries.push(entry)
	}
	return groups
}
