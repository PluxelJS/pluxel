import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { useStore } from '@tanstack/react-store'
import type { WorkbenchViewState } from '@pluxel/runtime/workbench/ui/internal'
import { useCurrentPathname } from '../router/useCurrentRoute'
import type { WorkspaceController } from './store'

export type WorkbenchLayoutContextValue = {
	leftPaneAvailable: boolean
	leftPaneVisible: boolean
	setLeftPaneVisible: (visible: boolean) => void
	toggleLeftPane: () => void
}

export type WorkbenchNavigationContextValue = {
	navigate: (path: string) => void
	openTab: (input: { path: string; title: string; meta?: string }) => void
}

const FALLBACK_LAYOUT_CONTEXT: WorkbenchLayoutContextValue = {
	leftPaneAvailable: false,
	leftPaneVisible: false,
	setLeftPaneVisible: () => {},
	toggleLeftPane: () => {},
}

const WorkbenchLayoutContext = createContext<WorkbenchLayoutContextValue | null>(null)
const WorkbenchNavigationContext = createContext<WorkbenchNavigationContextValue | null>(null)
const WorkspaceControllerContext = createContext<WorkspaceController | null>(null)
const WorkbenchDocumentContext = createContext<{ pathname: string; tabId: string } | null>(null)

export function WorkspaceControllerProvider({
	controller,
	children,
}: {
	controller: WorkspaceController
	children: ReactNode
}) {
	return (
		<WorkspaceControllerContext.Provider value={controller}>
			{children}
		</WorkspaceControllerContext.Provider>
	)
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

export function WorkbenchNavigationProvider({
	value,
	children,
}: {
	value: WorkbenchNavigationContextValue
	children: ReactNode
}) {
	return (
		<WorkbenchNavigationContext.Provider value={value}>
			{children}
		</WorkbenchNavigationContext.Provider>
	)
}

export function WorkbenchDocumentScope({
	pathname,
	tabId,
	children,
}: {
	pathname: string
	tabId: string
	children: ReactNode
}) {
	const value = useMemo(() => ({ pathname, tabId }), [pathname, tabId])
	return (
		<WorkbenchDocumentContext.Provider value={value}>{children}</WorkbenchDocumentContext.Provider>
	)
}

export function useWorkbenchLayout() {
	return useContext(WorkbenchLayoutContext) ?? FALLBACK_LAYOUT_CONTEXT
}

export function useOptionalWorkspaceNavigation() {
	return useContext(WorkbenchNavigationContext)
}

export function useWorkbenchNavigation(): WorkbenchNavigationContextValue {
	const navigation = useContext(WorkbenchNavigationContext)
	if (!navigation) throw new Error('Workbench navigation provider required')
	return navigation
}

export function useWorkspaceController(): WorkspaceController {
	const controller = useContext(WorkspaceControllerContext)
	if (!controller) throw new Error('WorkspaceController provider required')
	return controller
}

export function useActiveWorkbenchTabId(): string | null {
	const controller = useWorkspaceController()
	const scopedDocument = useContext(WorkbenchDocumentContext)
	const activeTabId = useStore(controller.store, (state) => {
		const activeGroup = state.uiState.editor.groups.find(
			(group) => group.id === state.uiState.editor.activeGroupId,
		)
		return activeGroup?.activeTabId ?? null
	})
	return scopedDocument?.tabId ?? activeTabId
}

/** The path rendered by the current editor pane, falling back to the browser location. */
export function useWorkbenchDocumentPathname(): string {
	const scopedDocument = useContext(WorkbenchDocumentContext)
	const browserPathname = useCurrentPathname()
	return scopedDocument?.pathname ?? browserPathname
}

export function useWorkbenchViewState(
	identity: string,
	frame: 'shell' | 'standalone',
): WorkbenchViewState | undefined {
	const controller = useWorkspaceController()
	const activeTabId = useActiveWorkbenchTabId()
	return useMemoWorkbenchViewState(controller, frame === 'shell' ? activeTabId : null, identity)
}

function useMemoWorkbenchViewState(
	controller: WorkspaceController,
	activeTabId: string | null,
	identity: string,
): WorkbenchViewState | undefined {
	return useMemo(() => {
		if (!activeTabId || !identity) return undefined
		const stateScope = (scope: string) => `remote-view:${identity}:${scope}`
		const read = (scope: string) =>
			controller.state.uiState.tabState[activeTabId]?.[stateScope(scope)]
		return Object.freeze({
			read,
			write(scope: string, value: unknown) {
				controller.setActiveTabState(activeTabId, stateScope(scope), value)
			},
			subscribe(scope: string, listener: () => void) {
				let current = read(scope)
				const subscription = controller.store.subscribe(() => {
					const next = read(scope)
					if (Object.is(current, next)) return
					current = next
					listener()
				})
				return () => subscription.unsubscribe()
			},
		})
	}, [activeTabId, controller, identity])
}
