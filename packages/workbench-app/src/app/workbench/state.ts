import { parsePluginDetailHref, parseWorkbenchHref } from '../../workbench/paths'
import {
	DEFAULT_PLUGIN_SECTION_LAYOUT,
	PLUGIN_RAIL_PANEL_ID,
	PLUGIN_SECTION_CONTENT_PANEL_ID,
	PLUGIN_WORKBENCH_PANELS_SCOPE,
	sanitizePluginSectionLayout,
	sanitizePluginWorkbenchPanelsState,
} from './split/plugin'
import type { EditorGridLayout } from './split/view'

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

export type WorkbenchEditorGroupState = {
	id: string
	tabIds: string[]
	activeTabId: string
}

export type WorkbenchEditorState = {
	activeGroupId: string | null
	groups: WorkbenchEditorGroupState[]
	layout: EditorGridLayout | undefined
}

export type WorkbenchUiState = {
	editor: WorkbenchEditorState
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
export const WORKBENCH_STORAGE_VERSION = 4 as const

const DEFAULT_EDITOR_GROUP_ID = 'group:main'

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isSafeIdentity(value: unknown, prefix: string): value is string {
	return (
		typeof value === 'string' &&
		value.startsWith(prefix) &&
		value.length > prefix.length &&
		value !== '__proto__' &&
		value !== 'constructor' &&
		value !== 'prototype'
	)
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
		editor: { activeGroupId: null, groups: [], layout: undefined },
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

function sanitizeWorkbenchTab(value: unknown): WorkbenchTab | undefined {
	if (!isRecord(value)) return undefined
	const instanceId = isSafeIdentity(value.instanceId, 'tab:') ? value.instanceId : undefined
	if (!instanceId) return undefined
	const storedPath =
		typeof value.path === 'string' && value.path.startsWith('/') ? value.path : undefined
	const path = storedPath ? sanitizeWorkbenchTabPath(storedPath) : undefined
	if (!path) return undefined
	const title = typeof value.title === 'string' && value.title.trim() ? value.title.trim() : '页面'
	const explicitDocumentKey =
		typeof value.documentKey === 'string' && value.documentKey === storedPath ? path : undefined
	return {
		instanceId,
		path,
		title,
		meta: typeof value.meta === 'string' && value.meta.trim() ? value.meta.trim() : undefined,
		documentKey: explicitDocumentKey,
	}
}

function sanitizeTabs(value: unknown) {
	const seen = new Set<string>()
	const documentInstances = new Map<string, string>()
	const duplicateTabIds = new Map<string, string>()
	const tabs = Array.isArray(value)
		? value.flatMap((raw) => {
				const tab = sanitizeWorkbenchTab(raw)
				if (!tab || seen.has(tab.instanceId)) return []
				seen.add(tab.instanceId)
				if (tab.documentKey) {
					const existingInstanceId = documentInstances.get(tab.documentKey)
					if (existingInstanceId) {
						duplicateTabIds.set(tab.instanceId, existingInstanceId)
						return []
					}
					documentInstances.set(tab.documentKey, tab.instanceId)
				}
				return [tab]
			})
		: []
	return { duplicateTabIds, tabs }
}

function sanitizeEditorLayout(
	value: unknown,
	groupIds: readonly string[],
): EditorGridLayout | undefined {
	const expected = new Set(groupIds)
	const seenGroups = new Set<string>()
	const seenSplits = new Set<string>()
	const ancestors = new Set<object>()

	const uniqueSplitId = (requested: string) => {
		if (!seenSplits.has(requested)) return requested
		let suffix = 2
		while (seenSplits.has(`${requested}:${suffix}`)) suffix += 1
		return `${requested}:${suffix}`
	}
	const visit = (input: unknown): EditorGridLayout | undefined => {
		if (!isRecord(input) || ancestors.has(input)) return undefined
		ancestors.add(input)
		if (input.type === 'group') {
			ancestors.delete(input)
			const groupId = input.groupId
			if (typeof groupId !== 'string' || !expected.has(groupId) || seenGroups.has(groupId)) {
				return undefined
			}
			seenGroups.add(groupId)
			return { type: 'group', groupId }
		}
		if (
			input.type !== 'split' ||
			(input.orientation !== 'horizontal' && input.orientation !== 'vertical') ||
			!Array.isArray(input.children)
		) {
			ancestors.delete(input)
			return undefined
		}
		const requestedId = typeof input.id === 'string' && input.id.trim() ? input.id : 'split'
		const id = uniqueSplitId(requestedId)
		seenSplits.add(id)
		const children = input.children.flatMap((rawChild) => {
			if (!isRecord(rawChild)) return []
			const node = visit(rawChild.node)
			if (!node) return []
			const size = rawChild.size
			return typeof size === 'number' && Number.isFinite(size) && size >= 0
				? [{ node, size }]
				: [{ node }]
		})
		ancestors.delete(input)
		if (children.length < 2) {
			seenSplits.delete(id)
			return children[0]?.node
		}
		return { type: 'split', id, orientation: input.orientation, children }
	}

	let layout = visit(value)
	const missing = groupIds.filter((groupId) => !seenGroups.has(groupId))
	if (!layout) {
		if (missing.length === 0) return undefined
		if (missing.length === 1) return { type: 'group', groupId: missing[0]! }
		return {
			type: 'split',
			id: uniqueSplitId('root'),
			orientation: 'horizontal',
			children: missing.map((groupId) => ({ node: { type: 'group' as const, groupId } })),
		}
	}
	if (missing.length === 0) return layout
	const added = missing.map((groupId) => ({ node: { type: 'group' as const, groupId } }))
	if (layout.type === 'split' && layout.orientation === 'horizontal') {
		return { ...layout, children: [...layout.children, ...added] }
	}
	layout = {
		type: 'split',
		id: uniqueSplitId('root'),
		orientation: 'horizontal',
		children: [{ node: layout }, ...added],
	}
	return layout
}

function sanitizeEditorState(
	value: unknown,
	tabs: readonly WorkbenchTab[],
	duplicateTabIds: ReadonlyMap<string, string>,
): WorkbenchEditorState {
	if (tabs.length === 0) return { activeGroupId: null, groups: [], layout: undefined }
	const tabIds = new Set(tabs.map((tab) => tab.instanceId))
	const assignedTabIds = new Set<string>()
	const editorRecord = isRecord(value) ? value : {}
	const seenGroupIds = new Set<string>()
	const groups = Array.isArray(editorRecord.groups)
		? editorRecord.groups.flatMap<WorkbenchEditorGroupState>((rawGroup) => {
				if (!isRecord(rawGroup) || !isSafeIdentity(rawGroup.id, 'group:')) return []
				if (seenGroupIds.has(rawGroup.id)) return []
				seenGroupIds.add(rawGroup.id)
				const groupTabIds = Array.isArray(rawGroup.tabIds)
					? rawGroup.tabIds.flatMap((rawTabId) => {
							if (typeof rawTabId !== 'string') return []
							const tabId = duplicateTabIds.get(rawTabId) ?? rawTabId
							if (!tabIds.has(tabId) || assignedTabIds.has(tabId)) return []
							assignedTabIds.add(tabId)
							return [tabId]
						})
					: []
				if (groupTabIds.length === 0) return []
				const requestedActiveTabId =
					typeof rawGroup.activeTabId === 'string'
						? (duplicateTabIds.get(rawGroup.activeTabId) ?? rawGroup.activeTabId)
						: undefined
				return [
					{
						id: rawGroup.id,
						tabIds: groupTabIds,
						activeTabId: groupTabIds.includes(requestedActiveTabId ?? '')
							? requestedActiveTabId!
							: groupTabIds[0]!,
					},
				]
			})
		: []
	const unassignedTabIds = tabs
		.map((tab) => tab.instanceId)
		.filter((tabId) => !assignedTabIds.has(tabId))
	if (groups.length === 0) {
		groups.push({
			id: DEFAULT_EDITOR_GROUP_ID,
			tabIds: unassignedTabIds,
			activeTabId: unassignedTabIds[0]!,
		})
	} else if (unassignedTabIds.length > 0) {
		groups[0] = { ...groups[0]!, tabIds: [...groups[0]!.tabIds, ...unassignedTabIds] }
	}
	const requestedActiveGroupId =
		typeof editorRecord.activeGroupId === 'string' ? editorRecord.activeGroupId : undefined
	const activeGroupId = groups.some((group) => group.id === requestedActiveGroupId)
		? requestedActiveGroupId!
		: groups[0]!.id
	return {
		activeGroupId,
		groups,
		layout: sanitizeEditorLayout(
			editorRecord.layout,
			groups.map((group) => group.id),
		),
	}
}

function sanitizeWorkbenchUiState(value: unknown): WorkbenchUiState {
	if (!isRecord(value)) return createDefaultWorkbenchUiState()
	const { duplicateTabIds, tabs } = sanitizeTabs(value.tabs)
	const retainedInstanceIds = new Set(tabs.map((tab) => tab.instanceId))
	return {
		editor: sanitizeEditorState(value.editor, tabs, duplicateTabIds),
		navigationCollapsed: value.navigationCollapsed !== false,
		pluginPane: sanitizePluginPaneState(value.pluginPane),
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
	if (value.version === WORKBENCH_STORAGE_VERSION) return sanitizeWorkbenchUiState(value.state)
	return createDefaultWorkbenchUiState()
}

function sanitizeWorkbenchTabPath(path: string): string | undefined {
	if (path.startsWith('/plugins/') && !parsePluginDetailHref(path)) return undefined
	if (
		(path.startsWith('/workbench/') || path.startsWith('/workbench-standalone/')) &&
		!parseWorkbenchHref(path)
	) {
		return undefined
	}
	return path
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
