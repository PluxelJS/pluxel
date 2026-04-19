import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react'
import {
	DEFAULT_PLUGIN_WORKBENCH_PANELS_STATE,
	type ResolvedPluginWorkbenchPanelsState,
} from '../../../workbench/split'

export type PluginWorkbenchAsideContextValue = {
	asideAvailable: boolean
	assistHost: HTMLDivElement | null
	setAssistHost: (node: HTMLDivElement | null) => void
	assistVisible: boolean
	setAssistVisible: (visible: boolean) => void
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
	setAssistVisible: () => {},
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

export function PluginWorkbenchLayoutProvider({
	value,
	children,
}: {
	value: PluginWorkbenchLayoutContextValue
	children: ReactNode
}) {
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
