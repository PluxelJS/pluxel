import { createContext, type ReactNode, useContext, useEffect, useRef } from 'react'
import { createHmrWebClient, type HmrWebClient, type HmrWebClientOptions } from './client'

import './plugin-ui-augment'

const WebClientContext = createContext<HmrWebClient | null>(null)

export type HmrWebClientProviderProps = {
	children: ReactNode
	options?: HmrWebClientOptions
}

/**
 * Host-only provider for the HMR web client.
 *
 * Design:
 * - The app owns exactly one client instance (context is required).
 * - No global fetch patching and no hidden singleton fallback.
 */
export function HmrWebClientProvider({ options, children }: HmrWebClientProviderProps) {
	const ref = useRef<HmrWebClient | null>(null)
	if (!ref.current) ref.current = createHmrWebClient(options)

	useEffect(() => {
		return () => {
			ref.current?.dispose()
		}
	}, [])

	return <WebClientContext.Provider value={ref.current}>{children}</WebClientContext.Provider>
}

/**
 * Read the host-owned `HmrWebClient`.
 *
 * Throws when used outside `HmrWebClientProvider`.
 */
export function useHmrWebClient(): HmrWebClient {
	const client = useContext(WebClientContext)
	if (!client) {
		throw new Error('useHmrWebClient must be used within HmrWebClientProvider')
	}
	return client
}
