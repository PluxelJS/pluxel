import { Store } from '@tanstack/react-store'
import {
	DEFAULT_PLUGIN_WORKBENCH_PANELS_STATE,
	PLUGIN_WORKBENCH_PANELS_SCOPE,
	resolvePluginWorkbenchPanelsState,
	type ResolvedPluginWorkbenchPanelsState,
} from './pluginLayout'
import {
	getSectionPaneState,
	type WorkbenchSectionId,
	type WorkbenchState,
	readWorkbenchState,
} from './state'
import { deriveTabFromPath, syncWorkbenchTabs } from './tabs'

function createInitialState(): WorkbenchState {
	return {
		uiState: readWorkbenchState(),
		dirtyTabs: {},
	}
}

export const workbenchStore = new Store<WorkbenchState>(createInitialState())

export function syncWorkbenchLocation(pathname: string, mode: 'replace-active' | 'open-tab') {
	const currentTab = deriveTabFromPath(pathname)
	workbenchStore.setState((prev) => ({
		...prev,
		uiState: syncWorkbenchTabs(prev.uiState, currentTab, mode),
	}))
}

export function pruneWorkbenchDirtyTabs() {
	workbenchStore.setState((prev) => {
		const next: Record<string, boolean> = {}
		for (const tab of prev.uiState.tabs) {
			next[tab.id] = prev.dirtyTabs[tab.id] ?? false
		}
		const prevKeys = Object.keys(prev.dirtyTabs)
		const nextKeys = Object.keys(next)
		if (
			prevKeys.length === nextKeys.length &&
			nextKeys.every((key) => prev.dirtyTabs[key] === next[key])
		) {
			return prev
		}
		return {
			...prev,
			dirtyTabs: next,
		}
	})
}

export function setWorkbenchSectionPaneVisible(sectionId: WorkbenchSectionId, visible: boolean) {
	workbenchStore.setState((prev) => {
		const currentPaneState = getSectionPaneState(prev.uiState, sectionId)
		if (currentPaneState.visible === visible) return prev
		return {
			...prev,
			uiState: {
				...prev.uiState,
				sectionPanes: {
					...prev.uiState.sectionPanes,
					[sectionId]: {
						...currentPaneState,
						visible,
					},
				},
			},
		}
	})
}

export function toggleWorkbenchSectionPane(sectionId: WorkbenchSectionId) {
	workbenchStore.setState((prev) => {
		const currentPaneState = getSectionPaneState(prev.uiState, sectionId)
		return {
			...prev,
			uiState: {
				...prev.uiState,
				sectionPanes: {
					...prev.uiState.sectionPanes,
					[sectionId]: {
						...currentPaneState,
						visible: !currentPaneState.visible,
					},
				},
			},
		}
	})
}

export function setWorkbenchSectionPaneLayout(
	sectionId: WorkbenchSectionId,
	layout: Record<string, number>,
) {
	workbenchStore.setState((prev) => ({
		...prev,
		uiState: {
			...prev.uiState,
			sectionPanes: {
				...prev.uiState.sectionPanes,
				[sectionId]: {
					...getSectionPaneState(prev.uiState, sectionId),
					layout,
				},
			},
		},
	}))
}

export function setWorkbenchActiveTabId(tabId: string | null) {
	workbenchStore.setState((prev) => {
		if (prev.uiState.activeTabId === tabId) return prev
		return {
			...prev,
			uiState: {
				...prev.uiState,
				activeTabId: tabId,
			},
		}
	})
}

export function setWorkbenchPluginWorkbenchPanelsState(
	tabId: string | null,
	patch: Partial<ResolvedPluginWorkbenchPanelsState>,
) {
	if (!tabId) return
	workbenchStore.setState((prev) => {
		const currentState = resolvePluginWorkbenchPanelsState(prev.uiState.tabState, tabId)
		const nextState: ResolvedPluginWorkbenchPanelsState = {
			...DEFAULT_PLUGIN_WORKBENCH_PANELS_STATE,
			...currentState,
			...patch,
		}
		if (
			nextState.rightPaneVisible === currentState.rightPaneVisible &&
			nextState.dockVisible === currentState.dockVisible
		) {
			return prev
		}
		return {
			...prev,
			uiState: {
				...prev.uiState,
				tabState: {
					...prev.uiState.tabState,
					[tabId]: {
						...prev.uiState.tabState[tabId],
						[PLUGIN_WORKBENCH_PANELS_SCOPE]: nextState,
					},
				},
			},
		}
	})
}

export function setWorkbenchActiveTabState(tabId: string | null, scope: string, value: unknown) {
	if (!tabId || !scope) return
	workbenchStore.setState((prev) => {
		const currentState = prev.uiState.tabState[tabId] ?? {}
		if (value === undefined) {
			if (!(scope in currentState)) return prev
			const nextTabState = { ...currentState }
			delete nextTabState[scope]
			const nextAllState = { ...prev.uiState.tabState }
			if (Object.keys(nextTabState).length === 0) delete nextAllState[tabId]
			else nextAllState[tabId] = nextTabState
			return {
				...prev,
				uiState: {
					...prev.uiState,
					tabState: nextAllState,
				},
			}
		}
		if (Object.is(currentState[scope], value)) return prev
		return {
			...prev,
			uiState: {
				...prev.uiState,
				tabState: {
					...prev.uiState.tabState,
					[tabId]: {
						...currentState,
						[scope]: value,
					},
				},
			},
		}
	})
}

export function setWorkbenchTabDirty(tabId: string | null, dirty: boolean) {
	if (!tabId) return
	workbenchStore.setState((prev) => {
		if ((prev.dirtyTabs[tabId] ?? false) === dirty) return prev
		return {
			...prev,
			dirtyTabs: {
				...prev.dirtyTabs,
				[tabId]: dirty,
			},
		}
	})
}

export function closeWorkbenchTab(tabId: string) {
	workbenchStore.setState((prev) => {
		if (!prev.uiState.tabs.some((tab) => tab.id === tabId)) return prev
		const nextTabs = prev.uiState.tabs.filter((tab) => tab.id !== tabId)
		const closingActive = prev.uiState.activeTabId === tabId
		const index = prev.uiState.tabs.findIndex((tab) => tab.id === tabId)
		const fallbackTab =
			nextTabs[Math.max(0, index - 1)] ??
			nextTabs[Math.min(index, nextTabs.length - 1)] ??
			nextTabs[0] ??
			null
		const nextDirtyTabs = { ...prev.dirtyTabs }
		delete nextDirtyTabs[tabId]
		const nextTabState =
			tabId in prev.uiState.tabState
				? Object.fromEntries(
						Object.entries(prev.uiState.tabState).filter(
							([existingTabId]) => existingTabId !== tabId,
						),
					)
				: prev.uiState.tabState
		return {
			...prev,
			dirtyTabs: nextDirtyTabs,
			uiState: {
				...prev.uiState,
				activeTabId: closingActive ? (fallbackTab?.id ?? null) : prev.uiState.activeTabId,
				tabState: nextTabState,
				tabs: nextTabs,
			},
		}
	})
}

export function resetWorkbenchToHome() {
	const homeTab = deriveTabFromPath('/')
	workbenchStore.setState((prev) => ({
		...prev,
		dirtyTabs: {},
		uiState: {
			activeTabId: homeTab.id,
			sectionPanes: prev.uiState.sectionPanes,
			tabState: {},
			tabs: [homeTab],
		},
	}))
}
