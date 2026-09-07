import { resolveWorkbenchLocation } from './location'
import type { WorkbenchEditorGroupState, WorkbenchTab, WorkbenchUiState } from './state'
import type { EditorGridLayout } from './split/view'

export type WorkbenchDocumentInput = Readonly<{
	path: string
	title: string
	meta?: string
}>

function createIdentity(prefix: 'group:' | 'tab:', existingIds: ReadonlySet<string>) {
	let identity: string
	do {
		const randomId = globalThis.crypto?.randomUUID?.()
		identity = randomId
			? `${prefix}${randomId}`
			: `${prefix}${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`
	} while (existingIds.has(identity))
	return identity
}

function createTabInstanceId(tabs: readonly WorkbenchTab[]) {
	return createIdentity('tab:', new Set(tabs.map((tab) => tab.instanceId)))
}

export function createEditorGroupId(groups: readonly WorkbenchEditorGroupState[]) {
	return createIdentity('group:', new Set(groups.map((group) => group.id)))
}

function createNavigationTab(tabs: readonly WorkbenchTab[], path: string): WorkbenchTab {
	const descriptor = resolveWorkbenchLocation(path)
	return {
		instanceId: createTabInstanceId(tabs),
		path: descriptor.path,
		title: descriptor.title,
		meta: descriptor.meta,
	}
}

export function createInitialWorkbenchTab(path: string): WorkbenchTab {
	return createNavigationTab([], path)
}

function sameWorkbenchTab(left: WorkbenchTab, right: WorkbenchTab) {
	return (
		left.instanceId === right.instanceId &&
		left.path === right.path &&
		left.title === right.title &&
		left.meta === right.meta &&
		left.documentKey === right.documentKey
	)
}

export function findWorkbenchGroup(
	state: WorkbenchUiState,
	groupId: string | null | undefined = state.editor.activeGroupId,
) {
	return state.editor.groups.find((group) => group.id === groupId)
}

export function findWorkbenchGroupForTab(state: WorkbenchUiState, tabId: string) {
	return state.editor.groups.find((group) => group.tabIds.includes(tabId))
}

export function getActiveWorkbenchTab(state: WorkbenchUiState) {
	const group = findWorkbenchGroup(state)
	return group ? state.tabs.find((tab) => tab.instanceId === group.activeTabId) : undefined
}

function withInitialGroup(prev: WorkbenchUiState, tab: WorkbenchTab): WorkbenchUiState {
	const groupId = 'group:main'
	return {
		...prev,
		editor: {
			activeGroupId: groupId,
			groups: [{ id: groupId, tabIds: [tab.instanceId], activeTabId: tab.instanceId }],
			layout: { type: 'group', groupId },
		},
		tabs: [tab],
	}
}

function insertTabAfterActive(
	tabs: readonly WorkbenchTab[],
	group: WorkbenchEditorGroupState,
	tab: WorkbenchTab,
) {
	const activeCatalogIndex = tabs.findIndex((item) => item.instanceId === group.activeTabId)
	const nextTabs = [...tabs]
	nextTabs.splice(activeCatalogIndex < 0 ? tabs.length : activeCatalogIndex + 1, 0, tab)
	const activeGroupIndex = group.tabIds.indexOf(group.activeTabId)
	const tabIds = [...group.tabIds]
	tabIds.splice(activeGroupIndex < 0 ? tabIds.length : activeGroupIndex + 1, 0, tab.instanceId)
	return { nextTabs, tabIds }
}

function replaceGroup(state: WorkbenchUiState, nextGroup: WorkbenchEditorGroupState) {
	return state.editor.groups.map((group) => (group.id === nextGroup.id ? nextGroup : group))
}

function collectEditorSplitIds(layout: EditorGridLayout | undefined, ids: Set<string>) {
	if (!layout || layout.type === 'group') return
	ids.add(layout.id)
	for (const child of layout.children) collectEditorSplitIds(child.node, ids)
}

function uniqueEditorSplitId(layout: EditorGridLayout | undefined, requested: string) {
	const ids = new Set<string>()
	collectEditorSplitIds(layout, ids)
	if (!ids.has(requested)) return requested
	let suffix = 2
	while (ids.has(`${requested}:${suffix}`)) suffix += 1
	return `${requested}:${suffix}`
}

export function removeWorkbenchEditorGroupLayout(
	layout: EditorGridLayout | undefined,
	groupId: string,
): EditorGridLayout | undefined {
	if (!layout) return undefined
	if (layout.type === 'group') return layout.groupId === groupId ? undefined : layout
	const children = layout.children.flatMap((child) => {
		const node = removeWorkbenchEditorGroupLayout(child.node, groupId)
		return node ? [{ ...child, node }] : []
	})
	if (children.length === 0) return undefined
	if (children.length === 1) return children[0]!.node
	return children.length === layout.children.length &&
		children.every((child, index) => child.node === layout.children[index]?.node)
		? layout
		: { ...layout, children }
}

function appendWorkbenchEditorGroupLayout(
	layout: EditorGridLayout | undefined,
	groupId: string,
): EditorGridLayout {
	const groupNode = { type: 'group' as const, groupId }
	if (!layout) return groupNode
	if (layout.type === 'split' && layout.orientation === 'horizontal') {
		return { ...layout, children: [...layout.children, { node: groupNode }] }
	}
	return {
		type: 'split',
		id: uniqueEditorSplitId(layout, 'root'),
		orientation: 'horizontal',
		children: [{ node: layout }, { node: groupNode }],
	}
}

/** Creates a clean navigation instance beside the active Tab in one editor group. */
export function createAdjacentWorkbenchTab(
	prev: WorkbenchUiState,
	groupId = prev.editor.activeGroupId,
): WorkbenchUiState {
	const group = findWorkbenchGroup(prev, groupId)
	const activeTab = group
		? prev.tabs.find((tab) => tab.instanceId === group.activeTabId)
		: undefined
	if (!group || !activeTab) return prev
	const adjacent: WorkbenchTab = {
		instanceId: createTabInstanceId(prev.tabs),
		path: activeTab.path,
		title: activeTab.title,
		meta: activeTab.meta,
	}
	const { nextTabs, tabIds } = insertTabAfterActive(prev.tabs, group, adjacent)
	return {
		...prev,
		editor: {
			...prev.editor,
			activeGroupId: group.id,
			groups: replaceGroup(prev, { ...group, activeTabId: adjacent.instanceId, tabIds }),
		},
		tabs: nextTabs,
	}
}

/** Replaces the active clean instance in one group with an ordinary navigation target. */
export function replaceActiveWorkbenchTab(
	prev: WorkbenchUiState,
	path: string,
	groupId = prev.editor.activeGroupId,
): WorkbenchUiState {
	const group = findWorkbenchGroup(prev, groupId)
	if (!group) return openWorkbenchNavigationTab(prev, path, groupId)
	const activeIndex = prev.tabs.findIndex((tab) => tab.instanceId === group.activeTabId)
	if (activeIndex === -1) return openWorkbenchNavigationTab(prev, path, groupId)
	const activeTab = prev.tabs[activeIndex]!
	const descriptor = resolveWorkbenchLocation(path)
	const nextTab: WorkbenchTab = {
		instanceId: activeTab.instanceId,
		path: descriptor.path,
		title: descriptor.title,
		meta: descriptor.meta,
	}
	if (sameWorkbenchTab(activeTab, nextTab) && prev.editor.activeGroupId === group.id) return prev
	const tabs = [...prev.tabs]
	tabs[activeIndex] = nextTab
	return {
		...prev,
		editor: { ...prev.editor, activeGroupId: group.id },
		tabs,
	}
}

/** Opens an ordinary navigation target beside the active Tab in one group. */
export function openWorkbenchNavigationTab(
	prev: WorkbenchUiState,
	path: string,
	groupId = prev.editor.activeGroupId,
): WorkbenchUiState {
	const tab = createNavigationTab(prev.tabs, path)
	const group = findWorkbenchGroup(prev, groupId)
	if (!group) return withInitialGroup(prev, tab)
	const { nextTabs, tabIds } = insertTabAfterActive(prev.tabs, group, tab)
	return {
		...prev,
		editor: {
			...prev.editor,
			activeGroupId: group.id,
			groups: replaceGroup(prev, { ...group, activeTabId: tab.instanceId, tabIds }),
		},
		tabs: nextTabs,
	}
}

/** Opens or focuses a business document, deduplicated across the whole editor grid. */
export function openWorkbenchDocument(
	prev: WorkbenchUiState,
	input: WorkbenchDocumentInput,
	groupId = prev.editor.activeGroupId,
): WorkbenchUiState {
	const existingIndex = prev.tabs.findIndex((tab) => tab.documentKey === input.path)
	if (existingIndex !== -1) {
		const existing = prev.tabs[existingIndex]!
		const existingGroup = findWorkbenchGroupForTab(prev, existing.instanceId)
		if (!existingGroup) return prev
		const nextTab: WorkbenchTab = {
			instanceId: existing.instanceId,
			path: input.path,
			title: input.title,
			meta: input.meta,
			documentKey: input.path,
		}
		const tabs = sameWorkbenchTab(existing, nextTab)
			? prev.tabs
			: prev.tabs.map((tab, index) => (index === existingIndex ? nextTab : tab))
		const groups = replaceGroup(prev, { ...existingGroup, activeTabId: existing.instanceId })
		if (
			tabs === prev.tabs &&
			prev.editor.activeGroupId === existingGroup.id &&
			existingGroup.activeTabId === existing.instanceId
		) {
			return prev
		}
		return {
			...prev,
			editor: { ...prev.editor, activeGroupId: existingGroup.id, groups },
			tabs,
		}
	}

	const tab: WorkbenchTab = {
		instanceId: createTabInstanceId(prev.tabs),
		path: input.path,
		title: input.title,
		meta: input.meta,
		documentKey: input.path,
	}
	const group = findWorkbenchGroup(prev, groupId)
	if (!group) return withInitialGroup(prev, tab)
	const { nextTabs, tabIds } = insertTabAfterActive(prev.tabs, group, tab)
	return {
		...prev,
		editor: {
			...prev.editor,
			activeGroupId: group.id,
			groups: replaceGroup(prev, { ...group, activeTabId: tab.instanceId, tabIds }),
		},
		tabs: nextTabs,
	}
}

export function activateWorkbenchTab(
	prev: WorkbenchUiState,
	groupId: string,
	tabId: string,
): WorkbenchUiState {
	const group = findWorkbenchGroup(prev, groupId)
	if (!group?.tabIds.includes(tabId)) return prev
	if (prev.editor.activeGroupId === groupId && group.activeTabId === tabId) return prev
	return {
		...prev,
		editor: {
			...prev.editor,
			activeGroupId: groupId,
			groups: replaceGroup(prev, { ...group, activeTabId: tabId }),
		},
	}
}

export function focusWorkbenchGroup(prev: WorkbenchUiState, groupId: string): WorkbenchUiState {
	if (prev.editor.activeGroupId === groupId) return prev
	if (!findWorkbenchGroup(prev, groupId)) return prev
	return { ...prev, editor: { ...prev.editor, activeGroupId: groupId } }
}

export function moveWorkbenchTab(
	prev: WorkbenchUiState,
	input: { tabId: string; targetGroupId: string; targetIndex: number },
): WorkbenchUiState {
	const sourceGroup = findWorkbenchGroupForTab(prev, input.tabId)
	const targetGroup = findWorkbenchGroup(prev, input.targetGroupId)
	if (!sourceGroup || !targetGroup) return prev
	const sourceIndex = sourceGroup.tabIds.indexOf(input.tabId)
	if (sourceIndex < 0) return prev
	if (sourceGroup.id === targetGroup.id) {
		const withoutTab = sourceGroup.tabIds.filter((tabId) => tabId !== input.tabId)
		const targetIndex = Math.max(0, Math.min(input.targetIndex, withoutTab.length))
		withoutTab.splice(targetIndex, 0, input.tabId)
		if (withoutTab.every((tabId, index) => tabId === sourceGroup.tabIds[index])) {
			return activateWorkbenchTab(prev, sourceGroup.id, input.tabId)
		}
		return {
			...prev,
			editor: {
				...prev.editor,
				activeGroupId: sourceGroup.id,
				groups: replaceGroup(prev, {
					...sourceGroup,
					activeTabId: input.tabId,
					tabIds: withoutTab,
				}),
			},
		}
	}

	const sourceTabIds = sourceGroup.tabIds.filter((tabId) => tabId !== input.tabId)
	const targetTabIds = targetGroup.tabIds.filter((tabId) => tabId !== input.tabId)
	const targetIndex = Math.max(0, Math.min(input.targetIndex, targetTabIds.length))
	targetTabIds.splice(targetIndex, 0, input.tabId)
	const groups = prev.editor.groups.flatMap((group) => {
		if (group.id === sourceGroup.id) {
			if (sourceTabIds.length === 0) return []
			const fallbackIndex = Math.min(sourceIndex, sourceTabIds.length - 1)
			return [
				{
					...group,
					tabIds: sourceTabIds,
					activeTabId:
						group.activeTabId === input.tabId ? sourceTabIds[fallbackIndex]! : group.activeTabId,
				},
			]
		}
		if (group.id === targetGroup.id) {
			return [{ ...group, tabIds: targetTabIds, activeTabId: input.tabId }]
		}
		return [group]
	})
	return {
		...prev,
		editor: {
			...prev.editor,
			activeGroupId: targetGroup.id,
			groups,
			layout:
				sourceTabIds.length === 0
					? removeWorkbenchEditorGroupLayout(prev.editor.layout, sourceGroup.id)
					: prev.editor.layout,
		},
	}
}

export function splitWorkbenchTab(
	prev: WorkbenchUiState,
	input: { tabId: string },
): { state: WorkbenchUiState; groupId: string | null } {
	const sourceGroup = findWorkbenchGroupForTab(prev, input.tabId)
	if (!sourceGroup || sourceGroup.tabIds.length <= 1) return { state: prev, groupId: null }
	const sourceIndex = sourceGroup.tabIds.indexOf(input.tabId)
	const sourceTabIds = sourceGroup.tabIds.filter((tabId) => tabId !== input.tabId)
	const groupId = createEditorGroupId(prev.editor.groups)
	const nextSourceGroup = {
		...sourceGroup,
		tabIds: sourceTabIds,
		activeTabId:
			sourceGroup.activeTabId === input.tabId
				? sourceTabIds[Math.min(sourceIndex, sourceTabIds.length - 1)]!
				: sourceGroup.activeTabId,
	}
	const groups = replaceGroup(prev, nextSourceGroup)
	groups.push({ id: groupId, tabIds: [input.tabId], activeTabId: input.tabId })
	return {
		groupId,
		state: {
			...prev,
			editor: {
				...prev.editor,
				activeGroupId: groupId,
				groups,
				layout: appendWorkbenchEditorGroupLayout(prev.editor.layout, groupId),
			},
		},
	}
}
