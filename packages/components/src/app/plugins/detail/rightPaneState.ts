import type { ReactNode } from 'react'

export type RightPaneState = {
	path?: string
	tab?: string
	schema?: string
	schemas?: Record<string, string>
}

export type RightPaneTabGroup = {
	id: string
	label: string
	priority: number
	nodes: Array<{ key: string; node: ReactNode }>
}

export const CONFIG_GROUP_TAB_PREFIX = 'cfg:'
export const RIGHT_PANE_VIEW_STATE_KEY = 'plugin:right-pane'

export function isConfigTab(tab: string): boolean {
	return tab === 'config' || tab.startsWith(CONFIG_GROUP_TAB_PREFIX)
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export function deepEqual(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true
	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) return false
		for (let i = 0; i < a.length; i += 1) {
			if (!deepEqual(a[i], b[i])) return false
		}
		return true
	}
	if (isRecord(a) && isRecord(b)) {
		const aKeys = Object.keys(a)
		const bKeys = Object.keys(b)
		if (aKeys.length !== bKeys.length) return false
		for (const key of aKeys) {
			if (!(key in b)) return false
			if (!deepEqual(a[key], b[key])) return false
		}
		return true
	}
	return false
}

function readStringProp(obj: Record<string, unknown>, key: string): string | undefined {
	const value = obj[key]
	return typeof value === 'string' ? value : undefined
}

function readNumberProp(obj: Record<string, unknown>, key: string): number | undefined {
	const value = obj[key]
	return typeof value === 'number' ? value : undefined
}

function readStringMap(value: unknown): Record<string, string> | undefined {
	if (!isRecord(value)) return undefined
	const out: Record<string, string> = {}
	for (const [k, v] of Object.entries(value)) {
		if (typeof v === 'string') out[k] = v
	}
	return out
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
	if (segments.length === 0) return ''
	return `/${segments.join('/')}`
}

export function encodeURIComponentSafe(value: string): string {
	try {
		return encodeURIComponent(value)
	} catch {
		return value
	}
}

export function sanitizeRightPaneState(value: unknown): RightPaneState {
	if (!isRecord(value)) return {}
	return {
		path: readStringProp(value, 'path'),
		tab: readStringProp(value, 'tab'),
		schema: readStringProp(value, 'schema'),
		schemas: readStringMap(value.schemas),
	}
}

export function buildRightPaneTabGroups(
	pluginName: string,
	tabItems: Array<{ meta?: unknown }>,
	tabNodes: ReactNode[],
): RightPaneTabGroup[] {
	const entries = tabItems.map((item, index) => {
		const meta = isRecord(item.meta) ? item.meta : {}
		return {
			meta,
			node: tabNodes[index],
			nodeKey: readStringProp(meta, 'id') ?? `${pluginName}:tab:${index}`,
		}
	})
	const byId = new Map<string, RightPaneTabGroup>()

	for (const { meta, node, nodeKey } of entries) {
		const tabMeta =
			isRecord(meta) && isRecord(meta.tab) ? (meta.tab as Record<string, unknown>) : undefined
		const itemId = readStringProp(meta, 'id')
		const itemPriority = readNumberProp(meta, 'priority') ?? 0
		const rawGroupId =
			typeof tabMeta?.id === 'string' && tabMeta.id.trim().length > 0
				? tabMeta.id.trim()
				: itemId && itemId.length > 0
					? itemId
					: `${pluginName}:tab:${byId.size}`
		const groupId =
			rawGroupId === 'config' || rawGroupId === 'route'
				? `${pluginName}:tab:${rawGroupId}`
				: rawGroupId
		const itemLabel = readStringProp(meta, 'label')
		const tabLabel = tabMeta ? readStringProp(tabMeta, 'label') : undefined
		const groupLabel =
			typeof tabLabel === 'string' && tabLabel.trim().length > 0
				? tabLabel.trim()
				: typeof itemLabel === 'string' && itemLabel.trim().length > 0
					? itemLabel.trim()
					: '扩展面板'

		const existing = byId.get(groupId)
		if (!existing) {
			byId.set(groupId, {
				id: groupId,
				label: groupLabel,
				priority: itemPriority,
				nodes: node ? [{ key: nodeKey, node }] : [],
			})
			continue
		}

		existing.priority = Math.max(existing.priority, itemPriority)
		if (node) existing.nodes.push({ key: nodeKey, node })
	}

	return Array.from(byId.values()).sort((a, b) => {
		const prio = b.priority - a.priority
		if (prio !== 0) return prio
		return a.id.localeCompare(b.id)
	})
}

export function resolveStoredSchemaForTab(state: RightPaneState, tabId: string, tabKeys: string[]) {
	const stored = state.schemas?.[tabId]
	return stored && tabKeys.includes(stored) ? stored : undefined
}

export function resolveActiveRightPaneTab(params: {
	builtinTabFromPath?: string
	resolveTab: (value: string | undefined) => string | undefined
	showRouteTab: boolean
	showConfigTab: boolean
	showLevelsTab: boolean
	storedPathMatches: boolean
	storedTab?: string
	tabFromSearch?: string
	tabGroups: RightPaneTabGroup[]
}) {
	const resolved = params.resolveTab(params.tabFromSearch)
	const fallback = params.storedPathMatches ? params.resolveTab(params.storedTab) : undefined
	return (
		resolved ??
		fallback ??
		params.builtinTabFromPath ??
		(params.showRouteTab
			? 'route'
			: params.showConfigTab
				? 'config'
				: (params.tabGroups[0]?.id ?? (params.showLevelsTab ? 'logging' : 'config')))
	)
}

export function mergeRightPaneState(
	previous: RightPaneState,
	patch: RightPaneState,
	fallbackTab: string,
	fallbackSchema: string,
): RightPaneState {
	return {
		path: typeof patch.path === 'string' ? patch.path : previous.path,
		tab: typeof patch.tab === 'string' ? patch.tab : fallbackTab,
		schema: typeof patch.schema === 'string' ? patch.schema : fallbackSchema,
		schemas:
			patch.schemas && typeof patch.schemas === 'object'
				? { ...previous.schemas, ...patch.schemas }
				: previous.schemas,
	}
}

export function formatCompactSource(
	moduleId: string | null,
	packageName: string | null,
	version: string | null,
) {
	if (packageName) return `${packageName}${version ? `@${version}` : ''}`
	if (!moduleId) return '未知来源'
	return shortenPathSegments(moduleId)
}

export function shortenPathSegments(path: string, keep = 3) {
	const segments = path.split(/[/\\]+/).filter(Boolean)
	if (segments.length <= keep) return path
	return `…/${segments.slice(-keep).join('/')}`
}

export function resolveKnownPluginName(knownPluginNames: ReadonlySet<string>, pluginName: string) {
	if (knownPluginNames.has(pluginName)) return pluginName
	const hash = pluginName.lastIndexOf('#')
	return hash > 0 && knownPluginNames.has(pluginName.slice(0, hash))
		? pluginName.slice(0, hash)
		: undefined
}

export function matchesKnownPluginName(knownPluginNames: ReadonlySet<string>, pluginName: string) {
	return resolveKnownPluginName(knownPluginNames, pluginName) !== undefined
}
