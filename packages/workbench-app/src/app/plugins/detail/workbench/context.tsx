import { useStore } from '@tanstack/react-store'
import {
	createContext,
	startTransition,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	type ReactNode,
} from 'react'
import { useActiveWorkbenchTabId, useWorkspaceController } from '../../../workbench/context'
import {
	DEFAULT_PLUGIN_WORKBENCH_PANELS_STATE,
	PLUGIN_WORKBENCH_PANELS_SCOPE,
	resolvePluginWorkbenchPanelsState,
	type ResolvedPluginWorkbenchPanelsState,
} from '../../../workbench/split'

export type PluginWorkbenchAsideContextValue = {
	asideAvailable: boolean
	assistHost: HTMLDivElement | null
	setAssistHost: (node: HTMLDivElement | null) => void
	assistVisible: boolean
	setAssistClaim: (owner: symbol, visible: boolean) => void
}

export type PluginWorkbenchLayoutContextValue = ResolvedPluginWorkbenchPanelsState & {
	setRightPaneVisible: (visible: boolean) => void
	toggleRightPane: () => void
	setDockVisible: (visible: boolean) => void
	toggleDock: () => void
}

const FALLBACK_ASIDE_CONTEXT: PluginWorkbenchAsideContextValue = {
	asideAvailable: false,
	assistHost: null,
	setAssistHost: () => {},
	assistVisible: false,
	setAssistClaim: () => {},
}

const FALLBACK_LAYOUT_CONTEXT: PluginWorkbenchLayoutContextValue = {
	...DEFAULT_PLUGIN_WORKBENCH_PANELS_STATE,
	setRightPaneVisible: () => {},
	toggleRightPane: () => {},
	setDockVisible: () => {},
	toggleDock: () => {},
}

const PluginWorkbenchAsideContext = createContext<PluginWorkbenchAsideContextValue | null>(null)
const PluginWorkbenchLayoutContext = createContext<PluginWorkbenchLayoutContextValue | null>(null)

export function PluginWorkbenchAsideProvider({
	value,
	children,
}: {
	value: PluginWorkbenchAsideContextValue
	children: ReactNode
}) {
	return (
		<PluginWorkbenchAsideContext.Provider value={value}>
			{children}
		</PluginWorkbenchAsideContext.Provider>
	)
}

export function PluginWorkbenchLayoutProvider({ children }: { children: ReactNode }) {
	const workspace = useWorkspaceController()
	const activeTabId = useActiveWorkbenchTabId()
	const storedState = useStore(workspace.store, (state) =>
		activeTabId ? state.uiState.tabState[activeTabId]?.[PLUGIN_WORKBENCH_PANELS_SCOPE] : undefined,
	)
	const panels = useMemo(() => resolvePluginWorkbenchPanelsState(storedState), [storedState])
	const patchPanels = useCallback(
		(patch: Partial<ResolvedPluginWorkbenchPanelsState>) => {
			if (!activeTabId) return
			const current = resolvePluginWorkbenchPanelsState(
				workspace.state.uiState.tabState[activeTabId]?.[PLUGIN_WORKBENCH_PANELS_SCOPE],
			)
			const next = { ...current, ...patch }
			if (
				next.dockVisible === current.dockVisible &&
				next.rightPaneVisible === current.rightPaneVisible
			) {
				return
			}
			startTransition(() => {
				workspace.setActiveTabState(activeTabId, PLUGIN_WORKBENCH_PANELS_SCOPE, next)
			})
		},
		[activeTabId, workspace],
	)
	const value = useMemo<PluginWorkbenchLayoutContextValue>(
		() => ({
			...panels,
			setDockVisible: (visible) => patchPanels({ dockVisible: visible }),
			setRightPaneVisible: (visible) => patchPanels({ rightPaneVisible: visible }),
			toggleDock: () => patchPanels({ dockVisible: !panels.dockVisible }),
			toggleRightPane: () => patchPanels({ rightPaneVisible: !panels.rightPaneVisible }),
		}),
		[panels, patchPanels],
	)
	return (
		<PluginWorkbenchLayoutContext.Provider value={value}>
			{children}
		</PluginWorkbenchLayoutContext.Provider>
	)
}

export function usePluginWorkbenchAside() {
	return useContext(PluginWorkbenchAsideContext) ?? FALLBACK_ASIDE_CONTEXT
}

export function usePluginWorkbenchLayout() {
	return useContext(PluginWorkbenchLayoutContext) ?? FALLBACK_LAYOUT_CONTEXT
}

export function usePluginWorkbenchAssistVisibility(visible: boolean) {
	const { setAssistClaim } = usePluginWorkbenchAside()
	const claimRef = useRef<symbol | null>(null)
	if (!claimRef.current) {
		claimRef.current = Symbol('plugin-workbench-assist')
	}

	useEffect(() => {
		setAssistClaim(claimRef.current!, visible)
	}, [setAssistClaim, visible])

	useEffect(() => {
		const claim = claimRef.current!
		return () => {
			setAssistClaim(claim, false)
		}
	}, [setAssistClaim])
}
