import { Store } from '@tanstack/react-store'
import { hasSameLayout } from './split/storage'
import { type WorkbenchState, type WorkbenchTab, readWorkbenchState } from './state'
import {
	createInitialWorkbenchTab,
	createAdjacentWorkbenchTab,
	openWorkbenchDocument,
	openWorkbenchNavigationTab,
	replaceActiveWorkbenchTab,
	type WorkbenchDocumentInput,
} from './tabs'

const MAX_PENDING_NAVIGATIONS = 64

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

function reconcileWorkbenchLocation(
	store: Store<WorkbenchState>,
	pathname: string,
	requestedInstanceId: string | null,
) {
	store.setState((prev) => {
		const active = prev.uiState.tabs.find((tab) => tab.instanceId === prev.uiState.activeTabId)
		const requested = requestedInstanceId
			? prev.uiState.tabs.find((tab) => tab.instanceId === requestedInstanceId)
			: undefined
		if (requested?.path === pathname) {
			if (prev.uiState.activeTabId === requested.instanceId) return prev
			return {
				...prev,
				uiState: { ...prev.uiState, activeTabId: requested.instanceId },
			}
		}
		if (active?.path === pathname) return prev
		const restoredDocument = requested
			? undefined
			: prev.uiState.tabs.find((tab) => tab.documentKey === pathname)
		if (restoredDocument) {
			return {
				...prev,
				uiState: { ...prev.uiState, activeTabId: restoredDocument.instanceId },
			}
		}

		const baseUiState = requested
			? { ...prev.uiState, activeTabId: requested.instanceId }
			: prev.uiState
		const current = requested ?? active
		const nextUiState =
			!requested && current && prev.dirtyTabs[current.instanceId]
				? openWorkbenchNavigationTab(baseUiState, pathname)
				: replaceActiveWorkbenchTab(baseUiState, pathname)
		if (nextUiState === prev.uiState) return prev
		return commitWorkbenchUiState(prev, nextUiState)
	})
}

function openWorkbenchStoreDocument(store: Store<WorkbenchState>, input: WorkbenchDocumentInput) {
	store.setState((prev) => {
		const nextUiState = openWorkbenchDocument(prev.uiState, input)
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
	const tabIds = new Set(nextUiState.tabs.map((tab) => tab.instanceId))
	const dirtyTabs = retainTabRecords(prev.dirtyTabs, tabIds)
	const tabState = retainTabRecords(nextUiState.tabState, tabIds)
	return {
		...prev,
		dirtyTabs,
		uiState: tabState === nextUiState.tabState ? nextUiState : { ...nextUiState, tabState },
	}
}

function setWorkbenchPluginPaneVisible(store: Store<WorkbenchState>, visible: boolean) {
	store.setState((prev) => {
		if (prev.uiState.pluginPane.visible === visible) return prev
		return {
			...prev,
			uiState: {
				...prev.uiState,
				pluginPane: {
					...prev.uiState.pluginPane,
					visible,
				},
			},
		}
	})
}

function toggleWorkbenchPluginPane(store: Store<WorkbenchState>) {
	store.setState((prev) => {
		return {
			...prev,
			uiState: {
				...prev.uiState,
				pluginPane: {
					...prev.uiState.pluginPane,
					visible: !prev.uiState.pluginPane.visible,
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

function setWorkbenchPluginPaneLayout(
	store: Store<WorkbenchState>,
	layout: Record<string, number>,
) {
	store.setState((prev) => {
		if (hasSameLayout(prev.uiState.pluginPane.layout, layout)) return prev
		return {
			...prev,
			uiState: {
				...prev.uiState,
				pluginPane: {
					...prev.uiState.pluginPane,
					layout,
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
		if (!dirty) {
			const dirtyTabs = { ...prev.dirtyTabs }
			delete dirtyTabs[tabId]
			return { ...prev, dirtyTabs }
		}
		return {
			...prev,
			dirtyTabs: {
				...prev.dirtyTabs,
				[tabId]: true,
			},
		}
	})
}

function closeWorkbenchTab(store: Store<WorkbenchState>, tabId: string) {
	store.setState((prev) => {
		if (!prev.uiState.tabs.some((tab) => tab.instanceId === tabId)) return prev
		if (prev.uiState.tabs.length === 1) {
			const homeTab = createInitialWorkbenchTab('/')
			return {
				...prev,
				dirtyTabs: {},
				uiState: {
					activeTabId: homeTab.instanceId,
					navigationCollapsed: prev.uiState.navigationCollapsed,
					pluginPane: prev.uiState.pluginPane,
					tabState: {},
					tabs: [homeTab],
				},
			}
		}
		const nextTabs = prev.uiState.tabs.filter((tab) => tab.instanceId !== tabId)
		const closingActive = prev.uiState.activeTabId === tabId
		const index = prev.uiState.tabs.findIndex((tab) => tab.instanceId === tabId)
		const fallbackTab = nextTabs[Math.max(0, index - 1)]!
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
				activeTabId: closingActive ? fallbackTab.instanceId : prev.uiState.activeTabId,
				tabState: nextTabState,
				tabs: nextTabs,
			},
		}
	})
}

function createAdjacentWorkbenchStoreTab(store: Store<WorkbenchState>) {
	store.setState((prev) => {
		const uiState = createAdjacentWorkbenchTab(prev.uiState)
		return uiState === prev.uiState ? prev : { ...prev, uiState }
	})
}

export class WorkspaceController {
	readonly store: Store<WorkbenchState>
	private pendingNavigations: Array<{ to: string; instanceId: string }> = []

	constructor(initialPathname?: string) {
		this.store = new Store<WorkbenchState>(createInitialState())
		if (initialPathname) this.reconcileLocation(initialPathname)
	}

	get state(): WorkbenchState {
		return this.store.state
	}

	private enqueueNavigation(to: string, instanceId: string): void {
		const last = this.pendingNavigations.at(-1)
		if (last?.to === to && last.instanceId === instanceId) return
		this.pendingNavigations.push({ to, instanceId })
		if (this.pendingNavigations.length > MAX_PENDING_NAVIGATIONS) {
			this.pendingNavigations.splice(0, this.pendingNavigations.length - MAX_PENDING_NAVIGATIONS)
		}
	}

	reconcileLocation(pathname: string): void {
		const pendingIndex = this.pendingNavigations.findIndex((intent) => intent.to === pathname)
		const pending = pendingIndex === -1 ? undefined : this.pendingNavigations[pendingIndex]
		this.pendingNavigations =
			pendingIndex === -1 ? [] : this.pendingNavigations.slice(pendingIndex + 1)
		reconcileWorkbenchLocation(this.store, pathname, pending?.instanceId ?? null)
	}

	openTab(input: { path: string; title: string; meta?: string }): void {
		openWorkbenchStoreDocument(this.store, input)
		const instanceId = this.state.uiState.activeTabId
		if (instanceId) this.enqueueNavigation(input.path, instanceId)
	}

	setPluginPaneVisible(visible: boolean): void {
		setWorkbenchPluginPaneVisible(this.store, visible)
	}

	togglePluginPane(): void {
		toggleWorkbenchPluginPane(this.store)
	}

	toggleNavigationCollapsed(): void {
		toggleWorkbenchNavigationCollapsed(this.store)
	}

	setPluginPaneLayout(layout: Record<string, number>): void {
		setWorkbenchPluginPaneLayout(this.store, layout)
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
		return tabs.find((tab) => tab.instanceId === activeTabId) ?? null
	}

	createAdjacentTab(): WorkbenchTab | null {
		createAdjacentWorkbenchStoreTab(this.store)
		const { tabs, activeTabId } = this.state.uiState
		return tabs.find((tab) => tab.instanceId === activeTabId) ?? null
	}

	requestNavigation(to: string): void {
		const { activeTabId, tabs } = this.state.uiState
		const activeTab = tabs.find((tab) => tab.instanceId === activeTabId)
		if (activeTab?.path === to) return
		if (!activeTab || this.state.dirtyTabs[activeTab.instanceId]) {
			this.store.setState((prev) => ({
				...prev,
				uiState: openWorkbenchNavigationTab(prev.uiState, to),
			}))
		}
		const instanceId = this.state.uiState.activeTabId
		if (instanceId) this.enqueueNavigation(to, instanceId)
	}
}
