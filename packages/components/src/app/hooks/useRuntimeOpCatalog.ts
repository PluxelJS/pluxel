import { useCallback, useEffect, useRef, useState } from 'react'
import type { RuntimeOpCatalogEntry } from '@pluxel/runtime/web'

import { listRuntimeOpCatalog } from '../../runtime'
import { subscribeInvalidations } from '../data/invalidations'

export type RuntimeOpCatalogState = {
	data?: RuntimeOpCatalogEntry[]
	loading: boolean
	error?: Error
	refetch: () => Promise<void>
}

let catalogCache: RuntimeOpCatalogEntry[] | undefined

export function invalidateRuntimeOpCatalogCache() {
	catalogCache = undefined
}

if (import.meta.hot) {
	import.meta.hot.on('vite:beforeUpdate', () => invalidateRuntimeOpCatalogCache())
}

async function loadRuntimeOpCatalog(forceRefresh = false): Promise<RuntimeOpCatalogEntry[]> {
	if (!forceRefresh && catalogCache) return catalogCache
	const data = await listRuntimeOpCatalog()
	catalogCache = data
	return data
}

export function useRuntimeOpCatalog(): RuntimeOpCatalogState {
	const [state, setState] = useState<{
		data?: RuntimeOpCatalogEntry[]
		loading: boolean
		error?: Error
	}>({
		data: catalogCache,
		loading: !catalogCache,
		error: undefined,
	})
	const stateRef = useRef(state)
	const abortRef = useRef<AbortController | null>(null)

	useEffect(() => {
		stateRef.current = state
	}, [state])

	const doFetch = useCallback(async (forceRefresh = false, preservedData?: RuntimeOpCatalogEntry[]) => {
		abortRef.current?.abort()
		const ctrl = (abortRef.current = new AbortController())

		setState({
			data: preservedData ?? stateRef.current.data,
			loading: true,
			error: undefined,
		})

		try {
			const data = await loadRuntimeOpCatalog(forceRefresh)
			if (ctrl.signal.aborted) return
			setState({ data, loading: false, error: undefined })
		} catch (error) {
			if (ctrl.signal.aborted) return
			setState({
				data: stateRef.current.data,
				loading: false,
				error: error instanceof Error ? error : new Error('加载 ops catalog 失败'),
			})
		}
	}, [])

	useEffect(() => {
		const cached = catalogCache
		setState({ data: cached, loading: !cached, error: undefined })
		void doFetch(false, cached)
		const unsubscribe = subscribeInvalidations((event) => {
			if (event.topic !== 'plugin-status' && event.topic !== 'plugin-manifest') return
			invalidateRuntimeOpCatalogCache()
			void doFetch(true, stateRef.current.data)
		})
		return () => {
			unsubscribe()
			abortRef.current?.abort()
		}
	}, [doFetch])

	return {
		...state,
		refetch: useCallback(async () => {
			invalidateRuntimeOpCatalogCache()
			await doFetch(true, stateRef.current.data)
		}, [doFetch]),
	}
}
