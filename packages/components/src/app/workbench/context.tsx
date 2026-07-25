import { createContext, useContext, useMemo, type ReactNode } from 'react'
import type { WorkspaceController } from './store'

export type WorkbenchLayoutContextValue = {
	leftPaneAvailable: boolean
	leftPaneVisible: boolean
	setLeftPaneVisible: (visible: boolean) => void
	toggleLeftPane: () => void
}

export type WorkbenchNavigationMode = 'replace-active' | 'open-tab'
export type WorkbenchNavigationRequest = WorkbenchNavigationMode | 'auto'

export type WorkbenchTabsContextValue = {
	activeTabId: string | null
	activeTabPath: string | null
	activeTabDirty: boolean
	isTabDirty: (tabId: string | null) => boolean
	getActiveTabState: <T = unknown>(scope: string) => T | undefined
	openTab: (input: { to: string; title: string; meta?: string }) => void
	setActiveTabState: (scope: string, value: unknown) => void
	requestNavigation: (to: string, request?: WorkbenchNavigationRequest) => WorkbenchNavigationMode
	setActiveTabDirty: (dirty: boolean) => void
}

export type WorkbenchTabIdentityContextValue = Pick<
	WorkbenchTabsContextValue,
	'activeTabId' | 'activeTabPath'
>

export type WorkbenchTabDirtyContextValue = Pick<
	WorkbenchTabsContextValue,
	'activeTabDirty' | 'isTabDirty' | 'setActiveTabDirty'
>

export type WorkbenchTabStateContextValue = Pick<
	WorkbenchTabsContextValue,
	'getActiveTabState' | 'setActiveTabState'
>

export type WorkbenchNavigationContextValue = Pick<WorkbenchTabsContextValue, 'requestNavigation'>

const FALLBACK_LAYOUT_CONTEXT: WorkbenchLayoutContextValue = {
	leftPaneAvailable: false,
	leftPaneVisible: false,
	setLeftPaneVisible: () => {},
	toggleLeftPane: () => {},
}

const FALLBACK_TAB_IDENTITY_CONTEXT: WorkbenchTabIdentityContextValue = {
	activeTabId: null,
	activeTabPath: null,
}

const FALLBACK_TAB_DIRTY_CONTEXT: WorkbenchTabDirtyContextValue = {
	activeTabDirty: false,
	isTabDirty: () => false,
	setActiveTabDirty: () => {},
}

const FALLBACK_TAB_STATE_CONTEXT: WorkbenchTabStateContextValue = {
	getActiveTabState: <T = unknown,>() => undefined as T | undefined,
	setActiveTabState: () => {},
}

const FALLBACK_NAVIGATION_CONTEXT: WorkbenchNavigationContextValue = {
	requestNavigation: () => 'replace-active',
}

const WorkbenchLayoutContext = createContext<WorkbenchLayoutContextValue | null>(null)
const WorkbenchTabsContext = createContext<WorkbenchTabsContextValue | null>(null)
const WorkbenchTabIdentityContext = createContext<WorkbenchTabIdentityContextValue | null>(null)
const WorkbenchTabDirtyContext = createContext<WorkbenchTabDirtyContextValue | null>(null)
const WorkbenchTabStateContext = createContext<WorkbenchTabStateContextValue | null>(null)
const WorkbenchNavigationContext = createContext<WorkbenchNavigationContextValue | null>(null)
const WorkspaceControllerContext = createContext<WorkspaceController | null>(null)

export function WorkbenchLayoutProvider({
	value,
	children,
}: {
	value: WorkbenchLayoutContextValue
	children: ReactNode
}) {
	return <WorkbenchLayoutContext.Provider value={value}>{children}</WorkbenchLayoutContext.Provider>
}

export function WorkbenchTabsProvider({
	controller,
	value,
	children,
}: {
	controller: WorkspaceController
	value: WorkbenchTabsContextValue
	children: ReactNode
}) {
	const identityValue = useMemo<WorkbenchTabIdentityContextValue>(
		() => ({
			activeTabId: value.activeTabId,
			activeTabPath: value.activeTabPath,
		}),
		[value.activeTabId, value.activeTabPath],
	)
	const dirtyValue = useMemo<WorkbenchTabDirtyContextValue>(
		() => ({
			activeTabDirty: value.activeTabDirty,
			isTabDirty: value.isTabDirty,
			setActiveTabDirty: value.setActiveTabDirty,
		}),
		[value.activeTabDirty, value.isTabDirty, value.setActiveTabDirty],
	)
	const stateValue = useMemo<WorkbenchTabStateContextValue>(
		() => ({
			getActiveTabState: value.getActiveTabState,
			setActiveTabState: value.setActiveTabState,
		}),
		[value.getActiveTabState, value.setActiveTabState],
	)
	const navigationValue = useMemo<WorkbenchNavigationContextValue>(
		() => ({
			requestNavigation: value.requestNavigation,
		}),
		[value.requestNavigation],
	)

	return (
		<WorkspaceControllerContext.Provider value={controller}>
			<WorkbenchTabsContext.Provider value={value}>
				<WorkbenchTabIdentityContext.Provider value={identityValue}>
					<WorkbenchTabDirtyContext.Provider value={dirtyValue}>
						<WorkbenchTabStateContext.Provider value={stateValue}>
							<WorkbenchNavigationContext.Provider value={navigationValue}>
								{children}
							</WorkbenchNavigationContext.Provider>
						</WorkbenchTabStateContext.Provider>
					</WorkbenchTabDirtyContext.Provider>
				</WorkbenchTabIdentityContext.Provider>
			</WorkbenchTabsContext.Provider>
		</WorkspaceControllerContext.Provider>
	)
}

export function useWorkbenchLayout() {
	return useContext(WorkbenchLayoutContext) ?? FALLBACK_LAYOUT_CONTEXT
}

export function useOptionalWorkspaceTabs() {
	return useContext(WorkbenchTabsContext)
}

export function useWorkbenchTabIdentity() {
	return useContext(WorkbenchTabIdentityContext) ?? FALLBACK_TAB_IDENTITY_CONTEXT
}

export function useWorkbenchTabDirty() {
	return useContext(WorkbenchTabDirtyContext) ?? FALLBACK_TAB_DIRTY_CONTEXT
}

export function useWorkbenchTabState() {
	return useContext(WorkbenchTabStateContext) ?? FALLBACK_TAB_STATE_CONTEXT
}

export function useWorkbenchNavigation() {
	return useContext(WorkbenchNavigationContext) ?? FALLBACK_NAVIGATION_CONTEXT
}

export function useWorkspaceController(): WorkspaceController {
	const controller = useContext(WorkspaceControllerContext)
	if (!controller) throw new Error('WorkspaceController provider required')
	return controller
}
