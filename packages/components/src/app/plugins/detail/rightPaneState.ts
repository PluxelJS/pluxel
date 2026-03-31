import type { ReactNode } from 'react'
import type { PluginDetailSearch } from '../../router'

export type RightPaneState = {
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

export function patchPluginDetailSearch(
	search: PluginDetailSearch,
	patch: Partial<PluginDetailSearch>,
): PluginDetailSearch {
	let changed = false
	const next: PluginDetailSearch = { ...search }
	for (const [key, value] of Object.entries(patch) as Array<
		[keyof PluginDetailSearch, string | undefined]
	>) {
		if (!value) {
			if (next[key] !== undefined) {
				delete next[key]
				changed = true
			}
			continue
		}
		if (next[key] !== value) {
			next[key] = value
			changed = true
		}
	}
	return changed ? next : search
}

export function sanitizeRightPaneState(value: unknown): RightPaneState {
	if (!isRecord(value)) return {}
	return {
		tab: readStringProp(value, 'tab'),
		schema: readStringProp(value, 'schema'),
		schemas: readStringMap(value.schemas),
	}
}

export function readStoredPaneState(
	getActiveTabState: <T = unknown>(scope: string) => T | undefined,
) {
	return sanitizeRightPaneState(getActiveTabState(RIGHT_PANE_VIEW_STATE_KEY))
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
	storedTab?: string
	tabFromSearch?: string
	tabGroups: RightPaneTabGroup[]
}) {
	const resolved = params.resolveTab(params.tabFromSearch)
	const fallback = params.showRouteTab ? undefined : params.resolveTab(params.storedTab)
	return (
		params.builtinTabFromPath ??
		resolved ??
		(params.showRouteTab
			? 'route'
			: (fallback ??
				(params.showConfigTab
					? 'config'
					: (params.tabGroups[0]?.id ?? (params.showLevelsTab ? 'logging' : 'config')))))
	)
}

export function mergeRightPaneState(
	previous: RightPaneState,
	patch: RightPaneState,
	fallbackTab: string,
	fallbackSchema: string,
): RightPaneState {
	return {
		tab: typeof patch.tab === 'string' ? patch.tab : fallbackTab,
		schema: typeof patch.schema === 'string' ? patch.schema : fallbackSchema,
		schemas:
			patch.schemas && typeof patch.schemas === 'object'
				? { ...(previous.schemas ?? {}), ...patch.schemas }
				: previous.schemas,
	}
}

export function buildRightPaneSearchSyncPatch(params: {
	activeSchemaKey: string
	activeTab: string
	builtinTabFromPath?: string
	resolveSchema: (value: string | undefined) => string | undefined
	resolveTab: (value: string | undefined) => string | undefined
	schemaFromSearch?: string
	schemaKeys: string[]
	schemaKeysByConfigTab: Map<string, string[]>
	showRouteTab: boolean
	tabFromSearch?: string
}) {
	if (params.resolveTab(params.tabFromSearch) === 'route' && params.schemaFromSearch) {
		return { schema: undefined } satisfies Partial<PluginDetailSearch>
	}

	if (params.showRouteTab) return null

	if (isConfigTab(params.activeTab)) {
		const tabKeys = params.schemaKeysByConfigTab.get(params.activeTab) ?? params.schemaKeys
		if (tabKeys.length > 0) {
			const fromSearch = params.resolveSchema(params.schemaFromSearch)
			if ((!fromSearch || !tabKeys.includes(fromSearch)) && params.activeSchemaKey) {
				return { schema: params.activeSchemaKey } satisfies Partial<PluginDetailSearch>
			}
		}
	}

	const resolvedTab = params.resolveTab(params.tabFromSearch)
	if (resolvedTab || params.activeTab === 'route') return null

	if (params.builtinTabFromPath === params.activeTab) {
		return {
			tab: undefined,
			schema: isConfigTab(params.activeTab) ? params.activeSchemaKey || undefined : undefined,
		} satisfies Partial<PluginDetailSearch>
	}

	return {
		tab: params.activeTab,
		schema: isConfigTab(params.activeTab) ? params.activeSchemaKey || undefined : undefined,
	} satisfies Partial<PluginDetailSearch>
}

export function formatCompactSource(
	moduleId: string | null,
	packageName: string | null,
	version: string | null,
) {
	if (packageName) return `${packageName}${version ? `@${version}` : ''}`
	if (!moduleId) return '未知来源'
	const segments = moduleId.split(/[/\\]+/).filter(Boolean)
	if (segments.length <= 3) return moduleId
	return `…/${segments.slice(-3).join('/')}`
}
