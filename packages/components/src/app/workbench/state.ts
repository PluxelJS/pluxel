import {
	DEFAULT_PLUGIN_SECTION_LAYOUT,
	PLUGIN_RAIL_PANEL_ID,
	PLUGIN_SECTION_CONTENT_PANEL_ID,
	PLUGIN_WORKBENCH_PANELS_SCOPE,
	sanitizePluginSectionLayout,
	sanitizePluginWorkbenchPanelsState,
} from './split/plugin'
export type WorkbenchTab = {
	id: string
	path: string
	title: string
	meta?: string
}

export type WorkbenchSectionId = 'home' | 'plugins' | 'packages' | 'logs' | 'other'
export type WorkbenchTabState = Record<string, Record<string, unknown>>
export type WorkbenchSectionPaneState = {
	visible: boolean
	layout: Record<string, number>
}
export type WorkbenchSectionPanes = Record<string, WorkbenchSectionPaneState>

export type WorkbenchUiState = {
	activeTabId: string | null
	navigationCollapsed: boolean
	sectionPanes: WorkbenchSectionPanes
	tabState: WorkbenchTabState
	tabs: WorkbenchTab[]
}

export type WorkbenchState = {
	uiState: WorkbenchUiState
	dirtyTabs: Record<string, boolean>
}

export const WORKBENCH_STORAGE_KEY = 'pluxel:workbench:ui'
export const PLUGINS_SECTION_ID = 'plugins' satisfies WorkbenchSectionId

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function sanitizeSectionPaneState(value: unknown, fallbackLayout: Record<string, number>) {
	const record = isRecord(value) ? value : {}
	return {
		visible: record.visible !== false,
		layout: isRecord(record.layout)
			? sanitizePluginSectionLayout({
					[PLUGIN_RAIL_PANEL_ID]:
						typeof record.layout[PLUGIN_RAIL_PANEL_ID] === 'number'
							? (record.layout[PLUGIN_RAIL_PANEL_ID] as number)
							: fallbackLayout[PLUGIN_RAIL_PANEL_ID],
					[PLUGIN_SECTION_CONTENT_PANEL_ID]:
						typeof record.layout[PLUGIN_SECTION_CONTENT_PANEL_ID] === 'number'
							? (record.layout[PLUGIN_SECTION_CONTENT_PANEL_ID] as number)
							: fallbackLayout[PLUGIN_SECTION_CONTENT_PANEL_ID],
				})
			: { ...fallbackLayout },
	}
}

function createDefaultSectionPaneState(sectionId: WorkbenchSectionId): WorkbenchSectionPaneState {
	if (sectionId === PLUGINS_SECTION_ID) {
		return {
			visible: true,
			layout: { ...DEFAULT_PLUGIN_SECTION_LAYOUT },
		}
	}
	return {
		visible: false,
		layout: { ...DEFAULT_PLUGIN_SECTION_LAYOUT },
	}
}

function createDefaultSectionPanes(): WorkbenchSectionPanes {
	return {
		[PLUGINS_SECTION_ID]: createDefaultSectionPaneState(PLUGINS_SECTION_ID),
	}
}

export function createDefaultWorkbenchUiState(): WorkbenchUiState {
	return {
		activeTabId: null,
		navigationCollapsed: true,
		sectionPanes: createDefaultSectionPanes(),
		tabState: {},
		tabs: [],
	}
}

export function sanitizeWorkbenchSectionPanes(value: unknown): WorkbenchSectionPanes {
	const defaults = createDefaultSectionPanes()
	if (!isRecord(value)) return defaults
	return {
		...defaults,
		[PLUGINS_SECTION_ID]: sanitizeSectionPaneState(
			value[PLUGINS_SECTION_ID],
			DEFAULT_PLUGIN_SECTION_LAYOUT,
		),
	}
}

export function getSectionPaneState(
	state: Pick<WorkbenchUiState, 'sectionPanes'>,
	sectionId: WorkbenchSectionId,
): WorkbenchSectionPaneState {
	return state.sectionPanes[sectionId] ?? createDefaultSectionPaneState(sectionId)
}

function sanitizeWorkbenchTabState(value: unknown): WorkbenchTabState {
	if (!isRecord(value)) return {}
	const next: WorkbenchTabState = {}
	for (const [tabId, tabState] of Object.entries(value)) {
		if (!isRecord(tabState)) continue
		const nextState = { ...tabState }
		if (PLUGIN_WORKBENCH_PANELS_SCOPE in nextState) {
			nextState[PLUGIN_WORKBENCH_PANELS_SCOPE] = sanitizePluginWorkbenchPanelsState(
				nextState[PLUGIN_WORKBENCH_PANELS_SCOPE],
			)
		}
		next[tabId] = nextState
	}
	return next
}

export function createPersistedWorkbenchState(state: WorkbenchUiState): WorkbenchUiState {
	return {
		...state,
		tabState: sanitizeWorkbenchTabState(state.tabState),
		sectionPanes: sanitizeWorkbenchSectionPanes(state.sectionPanes),
	}
}

export function readWorkbenchState(): WorkbenchUiState {
	if (typeof window === 'undefined') return createDefaultWorkbenchUiState()
	try {
		const raw = window.localStorage.getItem(WORKBENCH_STORAGE_KEY)
		if (!raw) return createDefaultWorkbenchUiState()
		const parsed = JSON.parse(raw)
		if (!isRecord(parsed)) throw new Error('invalid state')
		const tabs = Array.isArray(parsed.tabs)
			? parsed.tabs.filter(isRecord).map((tab) => ({
					id: typeof tab.id === 'string' ? tab.id : '',
					path: typeof tab.path === 'string' ? tab.path : '/',
					title: typeof tab.title === 'string' ? tab.title : '页面',
					meta: typeof tab.meta === 'string' ? tab.meta : undefined,
				}))
			: []
		return {
			activeTabId: typeof parsed.activeTabId === 'string' ? parsed.activeTabId : null,
			navigationCollapsed: parsed.navigationCollapsed !== false,
			sectionPanes: sanitizeWorkbenchSectionPanes(parsed.sectionPanes),
			tabState: sanitizeWorkbenchTabState(parsed.tabState),
			tabs,
		}
	} catch {
		return createDefaultWorkbenchUiState()
	}
}
