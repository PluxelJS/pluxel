import { createContext, useContext, type ReactNode } from 'react'

const PluginWorkbenchTabActivityContext = createContext(true)

export function PluginWorkbenchTabActivityProvider({
	active,
	children,
}: {
	active: boolean
	children: ReactNode
}) {
	return (
		<PluginWorkbenchTabActivityContext.Provider value={active}>
			{children}
		</PluginWorkbenchTabActivityContext.Provider>
	)
}

export function usePluginWorkbenchTabActivity() {
	return useContext(PluginWorkbenchTabActivityContext)
}
