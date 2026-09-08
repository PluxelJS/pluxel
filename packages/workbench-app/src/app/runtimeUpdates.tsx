import type { RuntimeUpdateSnapshot } from '@pluxel/runtime/web'
import { useQueryClient } from '@tanstack/react-query'
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { runtimeErrorMessage, useRuntimeManagementClient } from '../runtime'
import { managementQueryKeys, refetchManagementQuery } from './managementQuery'

type RuntimeUpdatesState = Readonly<{
	snapshot: RuntimeUpdateSnapshot | null
	ready: boolean
	error: string | null
}>
const RuntimeUpdatesContext = createContext<RuntimeUpdatesState>({
	snapshot: null,
	ready: false,
	error: null,
})

export function RuntimeUpdatesProvider({ children }: { children: ReactNode }) {
	const client = useRuntimeManagementClient()
	const queries = useQueryClient()
	const [state, setState] = useState<RuntimeUpdatesState>({
		snapshot: null,
		ready: false,
		error: null,
	})
	useEffect(() => {
		let active = true
		let subscription: Disposable | undefined
		let latest: RuntimeUpdateSnapshot | null = null
		void client.updates
			.follow((snapshot) => {
				if (!active) return
				if (
					latest &&
					(!snapshot ||
						snapshot.sequence < latest.sequence ||
						(snapshot.sequence === latest.sequence &&
							latest.state === 'settled' &&
							snapshot.state === 'updating'))
				)
					return
				latest = snapshot
				setState({ snapshot, ready: true, error: null })
				if (snapshot?.state === 'settled') {
					// Failed evaluation does not change the catalog revision. Its diagnostics still
					// change the plugin overview, and successful updates can change dependency edges.
					void Promise.all([
						refetchManagementQuery(queries, managementQueryKeys.pluginOverview()),
						refetchManagementQuery(queries, managementQueryKeys.pluginDependencyGraph()),
					]).catch(() => {
						// Each query retains its own read error; a session teardown must not leak a rejection.
					})
				}
			})
			.then((handle): void => {
				if (active) subscription = handle
				else handle[Symbol.dispose]()
				return undefined
			})
			.catch((error: unknown) => {
				if (active)
					setState((previous) => ({
						...previous,
						error: runtimeErrorMessage(error, '无法订阅更新状态'),
					}))
			})
		return () => {
			active = false
			subscription?.[Symbol.dispose]()
		}
	}, [client, queries])
	return <RuntimeUpdatesContext.Provider value={state}>{children}</RuntimeUpdatesContext.Provider>
}

export function useRuntimeUpdates(): RuntimeUpdatesState {
	return useContext(RuntimeUpdatesContext)
}
