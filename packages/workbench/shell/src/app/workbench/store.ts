import { Store } from '@tanstack/react-store'
import { PaneLayoutControlRegistry } from './PaneLayoutControlRegistry'
import { hasSameLayout } from './split/storage'
import type { EditorGridLayout } from './split/view'
import { type WorkbenchState, type WorkbenchTab, readWorkbenchState } from './state'
import {
	activateWorkbenchTab,
	createAdjacentWorkbenchTab,
	createInitialWorkbenchTab,
	findWorkbenchGroup,
	findWorkbenchGroupForTab,
	focusWorkbenchGroup,
	getActiveWorkbenchTab,
	moveWorkbenchTab,
	openWorkbenchDocument,
	openWorkbenchNavigationTab,
	removeWorkbenchEditorGroupLayout,
	replaceActiveWorkbenchTab,
	splitWorkbenchTab,
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
	requestedGroupId: string | null,
) {
	store.setState((prev) => {
		const active = getActiveWorkbenchTab(prev.uiState)
		const requested = requestedInstanceId
			? prev.uiState.tabs.find((tab) => tab.instanceId === requestedInstanceId)
			: undefined
		const requestedGroup = requested
			? findWorkbenchGroupForTab(prev.uiState, requested.instanceId)
			: undefined
		if (requested?.path === pathname && requestedGroup) {
			const nextUiState = activateWorkbenchTab(
				prev.uiState,
				requestedGroup.id,
				requested.instanceId,
			)
			return nextUiState === prev.uiState ? prev : { ...prev, uiState: nextUiState }
		}
		if (active?.path === pathname && !requested) return prev
		const restoredDocument = requested
			? undefined
			: prev.uiState.tabs.find((tab) => tab.documentKey === pathname)
		const restoredGroup = restoredDocument
			? findWorkbenchGroupForTab(prev.uiState, restoredDocument.instanceId)
			: undefined
		if (restoredDocument && restoredGroup) {
			return {
				...prev,
				uiState: activateWorkbenchTab(prev.uiState, restoredGroup.id, restoredDocument.instanceId),
			}
		}

		const targetGroupId =
			requestedGroup?.id ?? requestedGroupId ?? prev.uiState.editor.activeGroupId
		const baseUiState = requestedGroup
			? activateWorkbenchTab(prev.uiState, requestedGroup.id, requested!.instanceId)
			: targetGroupId
				? focusWorkbenchGroup(prev.uiState, targetGroupId)
				: prev.uiState
		const current = requested ?? getActiveWorkbenchTab(baseUiState)
		const nextUiState =
			!requested && current && prev.dirtyTabs[current.instanceId]
				? openWorkbenchNavigationTab(baseUiState, pathname, targetGroupId)
				: replaceActiveWorkbenchTab(baseUiState, pathname, targetGroupId)
		if (nextUiState === prev.uiState) return prev
		return commitWorkbenchUiState(prev, nextUiState)
	})
}

function openWorkbenchStoreDocument(
	store: Store<WorkbenchState>,
	input: WorkbenchDocumentInput,
	groupId?: string | null,
) {
	store.setState((prev) => {
		const nextUiState = openWorkbenchDocument(prev.uiState, input, groupId)
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
				pluginPane: { ...prev.uiState.pluginPane, visible },
			},
		}
	})
}

function toggleWorkbenchPluginPane(store: Store<WorkbenchState>) {
	store.setState((prev) => ({
		...prev,
		uiState: {
			...prev.uiState,
			pluginPane: { ...prev.uiState.pluginPane, visible: !prev.uiState.pluginPane.visible },
		},
	}))
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
				pluginPane: { ...prev.uiState.pluginPane, layout },
			},
		}
	})
}

function setWorkbenchEditorLayout(
	store: Store<WorkbenchState>,
	layout: EditorGridLayout | undefined,
) {
	store.setState((prev) => {
		if (hasSameStateValue(prev.uiState.editor.layout, layout)) return prev
		return {
			...prev,
			uiState: {
				...prev.uiState,
				editor: { ...prev.uiState.editor, layout },
			},
		}
	})
}

function setWorkbenchActiveTabs(
	store: Store<WorkbenchState>,
	activeTabs: Readonly<Record<string, string>>,
) {
	store.setState((prev) => {
		let changed = false
		const groups = prev.uiState.editor.groups.map((group) => {
			const tabId = activeTabs[group.id]
			if (!tabId || !group.tabIds.includes(tabId) || group.activeTabId === tabId) return group
			changed = true
			return { ...group, activeTabId: tabId }
		})
		return changed
			? {
					...prev,
					uiState: { ...prev.uiState, editor: { ...prev.uiState.editor, groups } },
				}
			: prev
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
				uiState: { ...prev.uiState, tabState: nextAllState },
			}
		}
		if (hasSameStateValue(currentState[scope], value)) return prev
		return {
			...prev,
			uiState: {
				...prev.uiState,
				tabState: {
					...prev.uiState.tabState,
					[tabId]: { ...currentState, [scope]: value },
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
		return { ...prev, dirtyTabs: { ...prev.dirtyTabs, [tabId]: true } }
	})
}

function setWorkbenchTabPresentation(
	store: Store<WorkbenchState>,
	tabId: string,
	input: Readonly<{ title: string; meta?: string }>,
) {
	const title = input.title.trim()
	if (!title) return
	const meta = input.meta?.trim() || undefined
	store.setState((prev) => {
		const index = prev.uiState.tabs.findIndex((tab) => tab.instanceId === tabId)
		if (index < 0) return prev
		const current = prev.uiState.tabs[index]!
		if (current.title === title && current.meta === meta) return prev
		const tabs = [...prev.uiState.tabs]
		tabs[index] = { ...current, title, ...(meta === undefined ? { meta: undefined } : { meta }) }
		return { ...prev, uiState: { ...prev.uiState, tabs } }
	})
}

function closeWorkbenchTab(store: Store<WorkbenchState>, tabId: string) {
	store.setState((prev) => {
		const sourceGroup = findWorkbenchGroupForTab(prev.uiState, tabId)
		if (!sourceGroup) return prev
		if (prev.uiState.tabs.length === 1) {
			const homeTab = createInitialWorkbenchTab('/')
			return {
				...prev,
				dirtyTabs: {},
				uiState: {
					...prev.uiState,
					editor: {
						activeGroupId: sourceGroup.id,
						groups: [
							{ id: sourceGroup.id, tabIds: [homeTab.instanceId], activeTabId: homeTab.instanceId },
						],
						layout: { type: 'group', groupId: sourceGroup.id },
					},
					tabState: {},
					tabs: [homeTab],
				},
			}
		}

		const sourceIndex = sourceGroup.tabIds.indexOf(tabId)
		const remainingSourceTabs = sourceGroup.tabIds.filter((item) => item !== tabId)
		let groups = prev.uiState.editor.groups
		let activeGroupId = prev.uiState.editor.activeGroupId
		let editorLayout = prev.uiState.editor.layout
		if (remainingSourceTabs.length > 0) {
			const fallbackTabId =
				remainingSourceTabs[Math.min(sourceIndex, remainingSourceTabs.length - 1)]!
			groups = groups.map((group) =>
				group.id === sourceGroup.id
					? {
							...group,
							tabIds: remainingSourceTabs,
							activeTabId: group.activeTabId === tabId ? fallbackTabId : group.activeTabId,
						}
					: group,
			)
		} else {
			const groupIndex = groups.findIndex((group) => group.id === sourceGroup.id)
			groups = groups.filter((group) => group.id !== sourceGroup.id)
			if (activeGroupId === sourceGroup.id) {
				activeGroupId = groups[Math.min(groupIndex, groups.length - 1)]?.id ?? groups[0]?.id ?? null
			}
			editorLayout = removeWorkbenchEditorGroupLayout(editorLayout, sourceGroup.id)
		}
		const tabs = prev.uiState.tabs.filter((tab) => tab.instanceId !== tabId)
		const dirtyTabs = { ...prev.dirtyTabs }
		delete dirtyTabs[tabId]
		const tabState = { ...prev.uiState.tabState }
		delete tabState[tabId]
		return {
			...prev,
			dirtyTabs,
			uiState: {
				...prev.uiState,
				editor: { ...prev.uiState.editor, activeGroupId, groups, layout: editorLayout },
				tabState,
				tabs,
			},
		}
	})
}

function createAdjacentWorkbenchStoreTab(store: Store<WorkbenchState>, groupId?: string | null) {
	store.setState((prev) => {
		const uiState = createAdjacentWorkbenchTab(prev.uiState, groupId)
		return uiState === prev.uiState ? prev : { ...prev, uiState }
	})
}

export class WorkspaceController {
	readonly store: Store<WorkbenchState>
	/** Mounted Pane Kit layouts publish transient header chrome here; serialized state stays in tabState. */
	readonly paneLayoutControls = new PaneLayoutControlRegistry()
	private pendingNavigations: Array<{ to: string; instanceId: string; groupId: string }> = []

	constructor(initialPathname?: string) {
		this.store = new Store<WorkbenchState>(createInitialState())
		if (initialPathname) this.reconcileLocation(initialPathname)
	}

	get state(): WorkbenchState {
		return this.store.state
	}

	get activeTab(): WorkbenchTab | null {
		return getActiveWorkbenchTab(this.state.uiState) ?? null
	}

	private enqueueNavigation(to: string, instanceId: string, groupId: string): void {
		const last = this.pendingNavigations.at(-1)
		if (last?.to === to && last.instanceId === instanceId && last.groupId === groupId) return
		this.pendingNavigations.push({ to, instanceId, groupId })
		if (this.pendingNavigations.length > MAX_PENDING_NAVIGATIONS) {
			this.pendingNavigations.splice(0, this.pendingNavigations.length - MAX_PENDING_NAVIGATIONS)
		}
	}

	reconcileLocation(pathname: string): void {
		const pendingIndex = this.pendingNavigations.findIndex((intent) => intent.to === pathname)
		const pending = pendingIndex === -1 ? undefined : this.pendingNavigations[pendingIndex]
		this.pendingNavigations =
			pendingIndex === -1 ? [] : this.pendingNavigations.slice(pendingIndex + 1)
		reconcileWorkbenchLocation(
			this.store,
			pathname,
			pending?.instanceId ?? null,
			pending?.groupId ?? null,
		)
	}

	openTab(input: WorkbenchDocumentInput, groupId?: string | null): WorkbenchTab | null {
		openWorkbenchStoreDocument(this.store, input, groupId)
		const activeTab = this.activeTab
		const activeGroupId = this.state.uiState.editor.activeGroupId
		if (activeTab && activeGroupId)
			this.enqueueNavigation(input.path, activeTab.instanceId, activeGroupId)
		return activeTab
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

	setEditorLayout(layout: EditorGridLayout | undefined): void {
		setWorkbenchEditorLayout(this.store, layout)
	}

	setActiveTabs(activeTabs: Readonly<Record<string, string>>): void {
		setWorkbenchActiveTabs(this.store, activeTabs)
	}

	focusGroup(groupId: string): WorkbenchTab | null {
		this.store.setState((prev) => {
			const uiState = focusWorkbenchGroup(prev.uiState, groupId)
			return uiState === prev.uiState ? prev : { ...prev, uiState }
		})
		return this.activeTab
	}

	activateTab(groupId: string, tabId: string): WorkbenchTab | null {
		this.store.setState((prev) => {
			const uiState = activateWorkbenchTab(prev.uiState, groupId, tabId)
			return uiState === prev.uiState ? prev : { ...prev, uiState }
		})
		return this.activeTab
	}

	setActiveTabState(tabId: string | null, scope: string, value: unknown): void {
		setWorkbenchActiveTabState(this.store, tabId, scope, value)
	}

	setTabDirty(tabId: string | null, dirty: boolean): void {
		setWorkbenchTabDirty(this.store, tabId, dirty)
	}

	setTabPresentation(tabId: string, input: Readonly<{ title: string; meta?: string }>): void {
		setWorkbenchTabPresentation(this.store, tabId, input)
	}

	closeTab(tabId: string): WorkbenchTab | null {
		closeWorkbenchTab(this.store, tabId)
		return this.activeTab
	}

	createAdjacentTab(groupId?: string | null): WorkbenchTab | null {
		createAdjacentWorkbenchStoreTab(this.store, groupId)
		return this.activeTab
	}

	moveTab(input: {
		tabId: string
		targetGroupId: string
		targetIndex: number
	}): WorkbenchTab | null {
		this.store.setState((prev) => {
			const uiState = moveWorkbenchTab(prev.uiState, input)
			return uiState === prev.uiState ? prev : commitWorkbenchUiState(prev, uiState)
		})
		return this.activeTab
	}

	splitTab(tabId: string): string | null {
		let createdGroupId: string | null = null
		this.store.setState((prev) => {
			const result = splitWorkbenchTab(prev.uiState, { tabId })
			createdGroupId = result.groupId
			return result.state === prev.uiState ? prev : { ...prev, uiState: result.state }
		})
		return createdGroupId
	}

	requestNavigation(to: string, groupId = this.state.uiState.editor.activeGroupId): void {
		if (groupId) this.focusGroup(groupId)
		const group = findWorkbenchGroup(this.state.uiState, groupId)
		const activeTab = group
			? this.state.uiState.tabs.find((tab) => tab.instanceId === group.activeTabId)
			: undefined
		if (activeTab?.path === to) return
		if (!activeTab || this.state.dirtyTabs[activeTab.instanceId]) {
			this.store.setState((prev) => {
				const uiState = openWorkbenchNavigationTab(prev.uiState, to, groupId)
				return { ...prev, uiState }
			})
		}
		const current = this.activeTab
		const activeGroupId = this.state.uiState.editor.activeGroupId
		if (current && activeGroupId) this.enqueueNavigation(to, current.instanceId, activeGroupId)
	}
}
