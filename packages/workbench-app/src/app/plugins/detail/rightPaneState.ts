import type { ReactNode } from 'react'
import type { WorkbenchLayoutEntry } from '@pluxel/runtime/workbench/client'

export type RightPaneTabGroup = {
	id: string
	label: string
	order: number
	nodes: Array<{ key: string; node: ReactNode }>
}

export function normalizeRestPath(raw?: string): string {
	if (!raw) return ''
	let decoded = raw
	try {
		decoded = decodeURIComponent(raw)
	} catch {
		decoded = raw
	}
	const segments = decoded
		.split('/')
		.map((segment) => segment.trim())
		.filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
	return segments.length === 0 ? '' : `/${segments.join('/')}`
}

export function buildRightPaneTabGroups(
	displayName: string,
	entries: readonly WorkbenchLayoutEntry[],
	nodes: ReactNode[],
): RightPaneTabGroup[] {
	const groups = new Map<string, RightPaneTabGroup>()
	for (const [index, entry] of entries.entries()) {
		const placement = entry.placement
		if (placement.kind !== 'tab') continue
		const requestedId = placement.group?.id ?? entry.descriptor.key
		const id =
			requestedId === 'config' || requestedId === 'route'
				? `${displayName}:${requestedId}`
				: requestedId
		const label = placement.group?.label ?? placement.label ?? entry.target.displayName
		const node = nodes[index]
		const existing = groups.get(id)
		if (existing) {
			existing.order = Math.min(existing.order, placement.order)
			if (node) existing.nodes.push({ key: entry.descriptor.key, node })
		} else {
			groups.set(id, {
				id,
				label,
				order: placement.order,
				nodes: node ? [{ key: entry.descriptor.key, node }] : [],
			})
		}
	}
	return [...groups.values()].sort(
		(left, right) => left.order - right.order || left.id.localeCompare(right.id),
	)
}

export function formatCompactSource(
	moduleId: string | null,
	packageName: string | null,
	version: string | null,
) {
	if (packageName) return `${packageName}${version ? `@${version}` : ''}`
	return moduleId ? shortenPathSegments(moduleId) : '未知来源'
}

export function shortenPathSegments(path: string, keep = 3) {
	const segments = path.split(/[/\\]+/).filter(Boolean)
	return segments.length <= keep ? path : `…/${segments.slice(-keep).join('/')}`
}
