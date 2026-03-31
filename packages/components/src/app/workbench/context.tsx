import { createContext, useContext, type ReactNode } from 'react'

export type WorkbenchLayoutContextValue = {
	leftPaneAvailable: boolean
	leftPaneVisible: boolean
	setLeftPaneVisible: (visible: boolean) => void
	toggleLeftPane: () => void
}

export type WorkbenchNavigationMode = 'replace-active' | 'open-tab'
export type WorkbenchNavigationRequest = WorkbenchNavigationMode | 'auto'

type PendingNavigationIntent = {
	mode: WorkbenchNavigationMode
	to: string
}

export type WorkbenchTabsContextValue = {
	activeTabId: string | null
	activeTabPath: string | null
	activeTabDirty: boolean
	isTabDirty: (tabId: string | null) => boolean
	getActiveTabState: <T = unknown>(scope: string) => T | undefined
	setActiveTabState: (scope: string, value: unknown) => void
	requestNavigation: (to: string, request?: WorkbenchNavigationRequest) => WorkbenchNavigationMode
	setActiveTabDirty: (dirty: boolean) => void
}

const FALLBACK_LAYOUT_CONTEXT: WorkbenchLayoutContextValue = {
	leftPaneAvailable: false,
	leftPaneVisible: false,
	setLeftPaneVisible: () => {},
	toggleLeftPane: () => {},
}

const FALLBACK_TABS_CONTEXT: WorkbenchTabsContextValue = {
	activeTabId: null,
	activeTabPath: null,
	activeTabDirty: false,
	isTabDirty: () => false,
	getActiveTabState: <T = unknown>() => undefined as T | undefined,
	setActiveTabState: () => {},
	requestNavigation: () => 'replace-active',
	setActiveTabDirty: () => {},
}

const WorkbenchLayoutContext = createContext<WorkbenchLayoutContextValue | null>(null)
const WorkbenchTabsContext = createContext<WorkbenchTabsContextValue | null>(null)

let pendingNavigationIntent: PendingNavigationIntent | null = null

export function queueWorkbenchNavigationIntent(intent: PendingNavigationIntent) {
	pendingNavigationIntent = intent
}

export function consumeWorkbenchNavigationIntent(pathname: string): PendingNavigationIntent | null {
	const intent = pendingNavigationIntent
	pendingNavigationIntent = null
	if (!intent) return null
	return intent.to === pathname ? intent : null
}

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
	value,
	children,
}: {
	value: WorkbenchTabsContextValue
	children: ReactNode
}) {
	return <WorkbenchTabsContext.Provider value={value}>{children}</WorkbenchTabsContext.Provider>
}

export function useWorkbenchLayout() {
	return useContext(WorkbenchLayoutContext) ?? FALLBACK_LAYOUT_CONTEXT
}

export function useWorkbenchTabs() {
	return useContext(WorkbenchTabsContext) ?? FALLBACK_TABS_CONTEXT
}
