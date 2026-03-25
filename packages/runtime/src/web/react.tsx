import { createContext, type ReactNode, useContext, useEffect, useRef } from 'react'
import {
	createRuntimeTransportClient,
	type RuntimeTransportClient,
	type RuntimeTransportClientOptions,
} from './client'

const RuntimeTransportClientContext = createContext<RuntimeTransportClient | null>(null)

export type RuntimeTransportClientProviderProps = {
	children: ReactNode
	options?: RuntimeTransportClientOptions
	client?: RuntimeTransportClient
}

/**
 * Host-only provider for the runtime transport client.
 *
 * Design:
 * - The app owns exactly one client instance (context is required).
 * - No global fetch patching and no hidden singleton fallback.
 */
export function RuntimeTransportClientProvider({
	options,
	client,
	children,
}: RuntimeTransportClientProviderProps) {
	const ref = useRef<RuntimeTransportClient | null>(null)
	const ownsClient = useRef(false)
	if (!ref.current) {
		ref.current = client ?? createRuntimeTransportClient(options)
		ownsClient.current = !client
	}

	useEffect(() => {
		return () => {
			if (ownsClient.current) ref.current?.dispose()
		}
	}, [])

	return (
		<RuntimeTransportClientContext.Provider value={ref.current}>
			{children}
		</RuntimeTransportClientContext.Provider>
	)
}

/**
 * Read the host-owned runtime transport client.
 *
 * Throws when used outside `RuntimeTransportClientProvider`.
 */
export function useRuntimeTransportClient(): RuntimeTransportClient {
	const client = useContext(RuntimeTransportClientContext)
	if (!client) {
		throw new Error(
			'useRuntimeTransportClient must be used within RuntimeTransportClientProvider',
		)
	}
	return client
}
