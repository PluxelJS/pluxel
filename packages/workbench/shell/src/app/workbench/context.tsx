import { createContext, useContext, type ReactNode } from 'react'

export type WorkbenchNavigationContextValue = {
	navigate: (path: string) => void
	openTab: (input: { path: string; title: string; meta?: string }) => void
}
const NavigationContext = createContext<WorkbenchNavigationContextValue | null>(null)
export function WorkbenchNavigationProvider({
	value,
	children,
}: {
	value: WorkbenchNavigationContextValue
	children: ReactNode
}) {
	return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>
}
export function useOptionalWorkspaceNavigation() {
	return useContext(NavigationContext)
}
export function useWorkbenchNavigation() {
	const value = useOptionalWorkspaceNavigation()
	if (!value) throw new Error('Workbench navigation provider required')
	return value
}
