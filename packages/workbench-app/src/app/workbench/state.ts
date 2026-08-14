import {
	DEFAULT_PLUGIN_SECTION_LAYOUT,
	PLUGIN_RAIL_PANEL_ID,
	PLUGIN_SECTION_CONTENT_PANEL_ID,
	PLUGIN_WORKBENCH_PANELS_SCOPE,
	sanitizePluginSectionLayout,
	sanitizePluginWorkbenchPanelsState,
} from './split/plugin'

export type WorkbenchTab = {
	/** Stable identity of this concrete Tab instance. */
	instanceId: string
	path: string
	title: string
	meta?: string
	/** Present only for business documents that `openTab()` must deduplicate. */
	documentKey?: string
}

export type WorkbenchTabState = Record<string, Record<string, unknown>>
export type WorkbenchPluginPaneState = {
	visible: boolean
	layout: Record<string, number>
}

export type WorkbenchUiState = {
	activeTabId: string | null
	navigationCollapsed: boolean
	pluginPane: WorkbenchPluginPaneState
	tabState: WorkbenchTabState
	tabs: WorkbenchTab[]
}

export type WorkbenchState = {
	uiState: WorkbenchUiState
	dirtyTabs: Record<string, boolean>
}

export const WORKBENCH_STORAGE_KEY = 'pluxel:workbench:ui'
export const WORKBENCH_STORAGE_VERSION = 2 as const

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function createDefaultPluginPaneState(): WorkbenchPluginPaneState {
	return {
		visible: true,
		layout: { ...DEFAULT_PLUGIN_SECTION_LAYOUT },
	}
}

function sanitizePluginPaneState(value: unknown): WorkbenchPluginPaneState {
	const record = isRecord(value) ? value : {}
	return {
		visible: record.visible !== false,
		layout: isRecord(record.layout)
			? sanitizePluginSectionLayout({
					[PLUGIN_RAIL_PANEL_ID]:
						typeof record.layout[PLUGIN_RAIL_PANEL_ID] === 'number'
							? (record.layout[PLUGIN_RAIL_PANEL_ID] as number)
							: DEFAULT_PLUGIN_SECTION_LAYOUT[PLUGIN_RAIL_PANEL_ID],
					[PLUGIN_SECTION_CONTENT_PANEL_ID]:
						typeof record.layout[PLUGIN_SECTION_CONTENT_PANEL_ID] === 'number'
							? (record.layout[PLUGIN_SECTION_CONTENT_PANEL_ID] as number)
							: DEFAULT_PLUGIN_SECTION_LAYOUT[PLUGIN_SECTION_CONTENT_PANEL_ID],
				})
			: { ...DEFAULT_PLUGIN_SECTION_LAYOUT },
	}
}

export function createDefaultWorkbenchUiState(): WorkbenchUiState {
	return {
		activeTabId: null,
		navigationCollapsed: true,
		pluginPane: createDefaultPluginPaneState(),
		tabState: {},
		tabs: [],
	}
}

function sanitizeWorkbenchTabState(
	value: unknown,
	instanceIds: ReadonlySet<string>,
): WorkbenchTabState {
	if (!isRecord(value)) return {}
	const entries: Array<[string, Record<string, unknown>]> = []
	for (const [instanceId, tabState] of Object.entries(value)) {
		if (!instanceIds.has(instanceId)) continue
		if (!isRecord(tabState)) continue
		const nextState = { ...tabState }
		if (PLUGIN_WORKBENCH_PANELS_SCOPE in nextState) {
			nextState[PLUGIN_WORKBENCH_PANELS_SCOPE] = sanitizePluginWorkbenchPanelsState(
				nextState[PLUGIN_WORKBENCH_PANELS_SCOPE],
			)
		}
		entries.push([instanceId, nextState])
	}
	return Object.fromEntries(entries)
}

function sanitizeWorkbenchTab(value: unknown, legacy: boolean): WorkbenchTab | undefined {
	if (!isRecord(value)) return undefined
	const legacyId = typeof value.id === 'string' ? value.id : undefined
	const instanceId =
		typeof value.instanceId === 'string' ? value.instanceId : legacy ? legacyId : undefined
	if (!instanceId?.trim()) return undefined
	if (!legacy && !instanceId.startsWith('tab:')) return undefined
	if (instanceId === '__proto__' || instanceId === 'constructor' || instanceId === 'prototype') {
		return undefined
	}
	const path = typeof value.path === 'string' && value.path.startsWith('/') ? value.path : undefined
	if (!path) return undefined
	const title = typeof value.title === 'string' && value.title.trim() ? value.title.trim() : '页面'
	const explicitDocumentKey =
		typeof value.documentKey === 'string' && value.documentKey === path ? path : undefined
	const legacyDocumentKey =
		legacy && value.kind === 'document' && !/:instance:\d+$/.test(instanceId) ? path : undefined
	return {
		instanceId,
		path,
		title,
		meta: typeof value.meta === 'string' && value.meta.trim() ? value.meta.trim() : undefined,
		documentKey: explicitDocumentKey ?? legacyDocumentKey,
	}
}

function sanitizeWorkbenchUiState(value: unknown, legacy: boolean): WorkbenchUiState {
	if (!isRecord(value)) return createDefaultWorkbenchUiState()
	const seen = new Set<string>()
	const documentInstances = new Map<string, string>()
	const duplicateDocumentInstances = new Map<string, string>()
	const tabs = Array.isArray(value.tabs)
		? value.tabs.flatMap((raw) => {
				const tab = sanitizeWorkbenchTab(raw, legacy)
				if (!tab || seen.has(tab.instanceId)) return []
				seen.add(tab.instanceId)
				if (tab.documentKey) {
					const existingInstanceId = documentInstances.get(tab.documentKey)
					if (existingInstanceId) {
						duplicateDocumentInstances.set(tab.instanceId, existingInstanceId)
						return []
					}
					documentInstances.set(tab.documentKey, tab.instanceId)
				}
				return [tab]
			})
		: []
	const storedActiveTabId =
		typeof value.activeTabId === 'string'
			? (duplicateDocumentInstances.get(value.activeTabId) ?? value.activeTabId)
			: undefined
	const activeTabId =
		storedActiveTabId && tabs.some((tab) => tab.instanceId === storedActiveTabId)
			? storedActiveTabId
			: (tabs[0]?.instanceId ?? null)
	const legacySectionPanes = legacy && isRecord(value.sectionPanes) ? value.sectionPanes : undefined
	const retainedInstanceIds = new Set(tabs.map((tab) => tab.instanceId))
	return {
		activeTabId,
		navigationCollapsed: value.navigationCollapsed !== false,
		pluginPane: sanitizePluginPaneState(value.pluginPane ?? legacySectionPanes?.plugins),
		tabState: sanitizeWorkbenchTabState(value.tabState, retainedInstanceIds),
		tabs,
	}
}

export function createPersistedWorkbenchState(state: WorkbenchUiState) {
	const instanceIds = new Set(state.tabs.map((tab) => tab.instanceId))
	return {
		version: WORKBENCH_STORAGE_VERSION,
		state: {
			...state,
			pluginPane: sanitizePluginPaneState(state.pluginPane),
			tabState: sanitizeWorkbenchTabState(state.tabState, instanceIds),
		},
	} as const
}

export function restoreWorkbenchState(value: unknown): WorkbenchUiState {
	if (!isRecord(value)) return createDefaultWorkbenchUiState()
	if (value.version === WORKBENCH_STORAGE_VERSION) {
		return sanitizeWorkbenchUiState(value.state, false)
	}
	return sanitizeWorkbenchUiState(value, true)
}

export function readWorkbenchState(): WorkbenchUiState {
	if (typeof window === 'undefined') return createDefaultWorkbenchUiState()
	try {
		const raw = window.localStorage.getItem(WORKBENCH_STORAGE_KEY)
		if (!raw) return createDefaultWorkbenchUiState()
		return restoreWorkbenchState(JSON.parse(raw) as unknown)
	} catch {
		return createDefaultWorkbenchUiState()
	}
}
