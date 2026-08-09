import { resolveWorkbenchLocation } from './location'
import type { WorkbenchTab, WorkbenchUiState } from './state'

export type WorkbenchDocumentInput = Readonly<{
	path: string
	title: string
	meta?: string
}>

function createTabInstanceId(tabs: readonly WorkbenchTab[]) {
	const existingIds = new Set(tabs.map((tab) => tab.instanceId))
	let instanceId: string
	do {
		const randomId = globalThis.crypto?.randomUUID?.()
		instanceId = randomId
			? `tab:${randomId}`
			: `tab:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`
	} while (existingIds.has(instanceId))
	return instanceId
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

/** Creates a clean navigation instance beside the active Tab. */
export function createAdjacentWorkbenchTab(prev: WorkbenchUiState): WorkbenchUiState {
	const activeIndex = prev.tabs.findIndex((tab) => tab.instanceId === prev.activeTabId)
	const activeTab = prev.tabs[activeIndex]
	if (!activeTab) return prev
	const adjacent: WorkbenchTab = {
		instanceId: createTabInstanceId(prev.tabs),
		path: activeTab.path,
		title: activeTab.title,
		meta: activeTab.meta,
	}
	const tabs = [...prev.tabs]
	tabs.splice(activeIndex + 1, 0, adjacent)
	return {
		...prev,
		activeTabId: adjacent.instanceId,
		tabs,
	}
}

/** Replaces the active clean instance with an ordinary navigation target. */
export function replaceActiveWorkbenchTab(prev: WorkbenchUiState, path: string): WorkbenchUiState {
	const activeIndex = prev.tabs.findIndex((tab) => tab.instanceId === prev.activeTabId)
	if (activeIndex === -1) return openWorkbenchNavigationTab(prev, path)
	const activeTab = prev.tabs[activeIndex]!
	const descriptor = resolveWorkbenchLocation(path)
	const nextTab: WorkbenchTab = {
		instanceId: activeTab.instanceId,
		path: descriptor.path,
		title: descriptor.title,
		meta: descriptor.meta,
	}
	if (sameWorkbenchTab(activeTab, nextTab)) return prev
	const tabs = [...prev.tabs]
	tabs[activeIndex] = nextTab
	return { ...prev, tabs }
}

/** Opens an ordinary navigation target in a new clean instance. */
export function openWorkbenchNavigationTab(prev: WorkbenchUiState, path: string): WorkbenchUiState {
	const tab = createNavigationTab(prev.tabs, path)
	return {
		...prev,
		activeTabId: tab.instanceId,
		tabs: [...prev.tabs, tab],
	}
}

/** Opens or focuses a business document, deduplicated only by its full path. */
export function openWorkbenchDocument(
	prev: WorkbenchUiState,
	input: WorkbenchDocumentInput,
): WorkbenchUiState {
	const existingIndex = prev.tabs.findIndex((tab) => tab.documentKey === input.path)
	if (existingIndex !== -1) {
		const existing = prev.tabs[existingIndex]!
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
		if (tabs === prev.tabs && prev.activeTabId === existing.instanceId) return prev
		return { ...prev, activeTabId: existing.instanceId, tabs }
	}

	const tab: WorkbenchTab = {
		instanceId: createTabInstanceId(prev.tabs),
		path: input.path,
		title: input.title,
		meta: input.meta,
		documentKey: input.path,
	}
	return {
		...prev,
		activeTabId: tab.instanceId,
		tabs: [...prev.tabs, tab],
	}
}
