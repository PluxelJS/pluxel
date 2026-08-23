import { createContext, type ReactNode, useContext, useRef } from 'react'
import {
	createRuntimeManagementClient,
	type RuntimeManagementClient,
	type RuntimeManagementClientOptions,
} from '../web/client'

const RuntimeManagementClientContext = createContext<RuntimeManagementClient | null>(null)

export type RuntimeManagementClientProviderProps = {
	children: ReactNode
	options?: RuntimeManagementClientOptions
	client?: RuntimeManagementClient
}

/** React binding for one host-owned, framework-neutral management client. */
export function RuntimeManagementClientProvider({
	options,
	client,
	children,
}: RuntimeManagementClientProviderProps) {
	const ref = useRef<RuntimeManagementClient | null>(null)
	if (!ref.current) ref.current = client ?? createRuntimeManagementClient(options)
	return (
		<RuntimeManagementClientContext.Provider value={ref.current}>
			{children}
		</RuntimeManagementClientContext.Provider>
	)
}

export function useRuntimeManagementClient(): RuntimeManagementClient {
	const client = useContext(RuntimeManagementClientContext)
	if (!client) {
		throw new Error(
			'useRuntimeManagementClient must be used within RuntimeManagementClientProvider',
		)
	}
	return client
}
