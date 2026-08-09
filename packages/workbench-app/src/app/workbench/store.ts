import { Store } from '@tanstack/react-store'
import { hasSameLayout } from './split/storage'
import {
	getSectionPaneState,
	type WorkbenchSectionId,
	type WorkbenchState,
	type WorkbenchTab,
	readWorkbenchState,
} from './state'
import { deriveTabFromPath, duplicateActiveWorkbenchTab, syncWorkbenchTabs } from './tabs'

function createInitialState(): WorkbenchState {
	return {
		uiState: readWorkbenchState(),
		dirtyTabs: {},
	}
}

function isPlainStateRecord(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false
	const proto = Object.getPrototypeOf(value)
	return proto === Object.prototype || proto === null
}

function hasSameStateValue(left: unknown, right: unknown, depth = 0): boolean {
	if (Object.is(left, right)) return true
	if (depth > 8) return false
	if (Array.isArray(left) && Array.isArray(right)) {
		return (
			left.length === right.length &&
			left.every((item, index) => hasSameStateValue(item, right[index], depth + 1))
		)
	}
	if (isPlainStateRecord(left) && isPlainStateRecord(right)) {
		const leftKeys = Object.keys(left)
		const rightKeys = Object.keys(right)
		return (
			leftKeys.length === rightKeys.length &&
			leftKeys.every((key) => key in right && hasSameStateValue(left[key], right[key], depth + 1))
		)
	}
	return false
}

function syncWorkbenchLocation(
	store: Store<WorkbenchState>,
	pathname: string,
	mode: 'replace-active' | 'open-tab',
) {
	const derivedTab = deriveTabFromPath(pathname)
	store.setState((prev) => {
		const existing = prev.uiState.tabs.find((tab) => tab.id === derivedTab.id)
		const active = prev.uiState.tabs.find((tab) => tab.id === prev.uiState.activeTabId)
		const currentTab =
			active?.path === pathname
				? active
				: existing?.kind === 'document' && existing.path === pathname
					? existing
					: derivedTab
		const nextUiState = syncWorkbenchTabs(prev.uiState, currentTab, mode)
		if (nextUiState === prev.uiState) return prev
		return commitWorkbenchUiState(prev, nextUiState)
	})
}

function openWorkbenchTab(
	store: Store<WorkbenchState>,
	input: { path: string; title: string; meta?: string },
) {
	const derived = deriveTabFromPath(input.path)
	const tab = {
		...derived,
		title: input.title,
		meta: input.meta,
		kind: 'document' as const,
	}
	store.setState((prev) => {
		const nextUiState = syncWorkbenchTabs(prev.uiState, tab, 'open-tab')
		if (nextUiState === prev.uiState) return prev
		return commitWorkbenchUiState(prev, nextUiState)
	})
}

function retainTabRecords<T>(records: Record<string, T>, tabIds: Set<string>) {
	const entries = Object.entries(records)
	if (entries.every(([tabId]) => tabIds.has(tabId))) return records
	return Object.fromEntries(entries.filter(([tabId]) => tabIds.has(tabId))) as Record<string, T>
}

function commitWorkbenchUiState(prev: WorkbenchState, nextUiState: WorkbenchState['uiState']) {
	const tabIds = new Set(nextUiState.tabs.map((tab) => tab.id))
	const dirtyTabs = retainTabRecords(prev.dirtyTabs, tabIds)
	const tabState = retainTabRecords(nextUiState.tabState, tabIds)
	return {
		...prev,
		dirtyTabs,
		uiState: tabState === nextUiState.tabState ? nextUiState : { ...nextUiState, tabState },
	}
}

function setWorkbenchSectionPaneVisible(
	store: Store<WorkbenchState>,
	sectionId: WorkbenchSectionId,
	visible: boolean,
) {
	store.setState((prev) => {
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

function toggleWorkbenchSectionPane(store: Store<WorkbenchState>, sectionId: WorkbenchSectionId) {
	store.setState((prev) => {
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

function toggleWorkbenchNavigationCollapsed(store: Store<WorkbenchState>) {
	store.setState((prev) => ({
		...prev,
		uiState: {
			...prev.uiState,
			navigationCollapsed: !prev.uiState.navigationCollapsed,
		},
	}))
}

function setWorkbenchSectionPaneLayout(
	store: Store<WorkbenchState>,
	sectionId: WorkbenchSectionId,
	layout: Record<string, number>,
) {
	store.setState((prev) => {
		const currentPaneState = getSectionPaneState(prev.uiState, sectionId)
		if (hasSameLayout(currentPaneState.layout, layout)) return prev
		return {
			...prev,
			uiState: {
				...prev.uiState,
				sectionPanes: {
					...prev.uiState.sectionPanes,
					[sectionId]: {
						...currentPaneState,
						layout,
					},
				},
			},
		}
	})
}

function setWorkbenchActiveTabId(store: Store<WorkbenchState>, tabId: string | null) {
	store.setState((prev) => {
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

function setWorkbenchActiveTabState(
	store: Store<WorkbenchState>,
	tabId: string | null,
	scope: string,
	value: unknown,
) {
	if (!tabId || !scope) return
	store.setState((prev) => {
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
		if (hasSameStateValue(currentState[scope], value)) return prev
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

function setWorkbenchTabDirty(store: Store<WorkbenchState>, tabId: string | null, dirty: boolean) {
	if (!tabId) return
	store.setState((prev) => {
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

function closeWorkbenchTab(store: Store<WorkbenchState>, tabId: string) {
	store.setState((prev) => {
		if (!prev.uiState.tabs.some((tab) => tab.id === tabId)) return prev
		if (prev.uiState.tabs.length === 1) {
			const homeTab = deriveTabFromPath('/')
			return {
				...prev,
				dirtyTabs: {},
				uiState: {
					activeTabId: homeTab.id,
					navigationCollapsed: prev.uiState.navigationCollapsed,
					sectionPanes: prev.uiState.sectionPanes,
					tabState: {},
					tabs: [homeTab],
				},
			}
		}
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

function duplicateActiveWorkbenchStoreTab(store: Store<WorkbenchState>) {
	store.setState((prev) => {
		const uiState = duplicateActiveWorkbenchTab(prev.uiState)
		return uiState === prev.uiState ? prev : { ...prev, uiState }
	})
}

type WorkspaceNavigationMode = 'replace-active' | 'open-tab'

export class WorkspaceController {
	readonly store = new Store<WorkbenchState>(createInitialState())
	private pendingNavigation: { to: string; mode: WorkspaceNavigationMode } | null = null

	get state(): WorkbenchState {
		return this.store.state
	}

	syncLocation(pathname: string, mode: WorkspaceNavigationMode): void {
		syncWorkbenchLocation(this.store, pathname, mode)
	}

	openTab(input: { path: string; title: string; meta?: string }): void {
		this.pendingNavigation = { to: input.path, mode: 'open-tab' }
		openWorkbenchTab(this.store, input)
	}

	setSectionPaneVisible(sectionId: WorkbenchSectionId, visible: boolean): void {
		setWorkbenchSectionPaneVisible(this.store, sectionId, visible)
	}

	toggleSectionPane(sectionId: WorkbenchSectionId): void {
		toggleWorkbenchSectionPane(this.store, sectionId)
	}

	toggleNavigationCollapsed(): void {
		toggleWorkbenchNavigationCollapsed(this.store)
	}

	setSectionPaneLayout(sectionId: WorkbenchSectionId, layout: Record<string, number>): void {
		setWorkbenchSectionPaneLayout(this.store, sectionId, layout)
	}

	setActiveTabId(tabId: string | null): void {
		setWorkbenchActiveTabId(this.store, tabId)
	}

	setActiveTabState(tabId: string | null, scope: string, value: unknown): void {
		setWorkbenchActiveTabState(this.store, tabId, scope, value)
	}

	setTabDirty(tabId: string | null, dirty: boolean): void {
		setWorkbenchTabDirty(this.store, tabId, dirty)
	}

	closeTab(tabId: string): WorkbenchTab | null {
		closeWorkbenchTab(this.store, tabId)
		const { tabs, activeTabId } = this.state.uiState
		return tabs.find((tab) => tab.id === activeTabId) ?? null
	}

	duplicateActiveTab(): WorkbenchTab | null {
		duplicateActiveWorkbenchStoreTab(this.store)
		const { tabs, activeTabId } = this.state.uiState
		return tabs.find((tab) => tab.id === activeTabId) ?? null
	}

	requestNavigation(to: string): void {
		const { activeTabId, tabs } = this.state.uiState
		const activeTab = tabs.find((tab) => tab.id === activeTabId)
		if (activeTab?.path === to) return
		const mode: WorkspaceNavigationMode =
			activeTab && this.state.dirtyTabs[activeTab.id] ? 'open-tab' : 'replace-active'
		this.pendingNavigation = { to, mode }
		if (mode === 'open-tab') {
			const tab = deriveTabFromPath(to)
			openWorkbenchTab(this.store, {
				path: tab.path,
				title: tab.title,
				meta: tab.meta,
			})
		}
	}

	consumeNavigation(pathname: string): { to: string; mode: WorkspaceNavigationMode } | null {
		const pending = this.pendingNavigation
		this.pendingNavigation = null
		return pending?.to === pathname ? pending : null
	}
}
