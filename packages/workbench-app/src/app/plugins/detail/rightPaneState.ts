import type { ReactNode } from 'react'
import type { WorkbenchLayoutItem } from '@pluxel/runtime/workbench'

export type RightPaneTabGroup = {
	id: string
	label: string
	priority: number
	nodes: Array<{ key: string; node: ReactNode }>
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function readStringProp(obj: Record<string, unknown>, key: string): string | undefined {
	const value = obj[key]
	return typeof value === 'string' ? value : undefined
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
	tabItems: readonly WorkbenchLayoutItem[],
	tabNodes: ReactNode[],
): RightPaneTabGroup[] {
	const byId = new Map<string, RightPaneTabGroup>()
	for (const [index, item] of tabItems.entries()) {
		const meta = isRecord(item.meta) ? item.meta : {}
		const tabMeta = isRecord(meta.tabGroup) ? meta.tabGroup : undefined
		const configuredId = tabMeta ? readStringProp(tabMeta, 'id')?.trim() : undefined
		const rawGroupId = configuredId || item.id || `${displayName}:tab:${byId.size}`
		const groupId =
			rawGroupId === 'config' || rawGroupId === 'route'
				? `${displayName}:tab:${rawGroupId}`
				: rawGroupId
		const configuredLabel = tabMeta ? readStringProp(tabMeta, 'label')?.trim() : undefined
		const itemLabel = readStringProp(meta, 'label')?.trim()
		const label = configuredLabel || itemLabel || '扩展面板'
		const node = tabNodes[index]
		const existing = byId.get(groupId)
		if (existing) {
			existing.priority = Math.max(existing.priority, item.priority)
			if (node) existing.nodes.push({ key: item.id, node })
		} else {
			byId.set(groupId, {
				id: groupId,
				label,
				priority: item.priority,
				nodes: node ? [{ key: item.id, node }] : [],
			})
		}
	}
	return [...byId.values()].sort(
		(left, right) => right.priority - left.priority || left.id.localeCompare(right.id),
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
