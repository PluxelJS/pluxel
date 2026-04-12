import { useCallback, useEffect, useRef, useState } from 'react'
import type { OpsToolset, OpsToolsetInput } from '@pluxel/runtime/web'

import { listRuntimeOpsToolsets, updateRuntimeOpsToolsets } from '../../runtime'

export type RuntimeOpsToolsetsState = {
	data?: OpsToolset[]
	loading: boolean
	saving: boolean
	error?: Error
	refetch: () => Promise<void>
	update: (toolsets: OpsToolsetInput[]) => Promise<OpsToolset[]>
}

let toolsetsCache: OpsToolset[] | undefined

export function invalidateRuntimeOpsToolsetsCache() {
	toolsetsCache = undefined
}

if (import.meta.hot) {
	import.meta.hot.on('vite:beforeUpdate', () => invalidateRuntimeOpsToolsetsCache())
}

async function loadRuntimeOpsToolsets(forceRefresh = false): Promise<OpsToolset[]> {
	if (!forceRefresh && toolsetsCache) return toolsetsCache
	const data = await listRuntimeOpsToolsets()
	toolsetsCache = data
	return data
}

export function useRuntimeOpsToolsets(): RuntimeOpsToolsetsState {
	const [state, setState] = useState<{
		data?: OpsToolset[]
		loading: boolean
		saving: boolean
		error?: Error
	}>({
		data: toolsetsCache,
		loading: !toolsetsCache,
		saving: false,
		error: undefined,
	})
	const stateRef = useRef(state)

	useEffect(() => {
		stateRef.current = state
	}, [state])

	const doFetch = useCallback(async (forceRefresh = false, preservedData?: OpsToolset[]) => {
		setState((current) => ({
			data: preservedData ?? current.data,
			loading: true,
			saving: current.saving,
			error: undefined,
		}))

		try {
			const data = await loadRuntimeOpsToolsets(forceRefresh)
			setState({ data, loading: false, saving: false, error: undefined })
		} catch (error) {
			setState((current) => ({
				data: current.data,
				loading: false,
				saving: current.saving,
				error: error instanceof Error ? error : new Error('加载 ops toolsets 失败'),
			}))
		}
	}, [])

	const update = useCallback(async (toolsets: OpsToolsetInput[]) => {
		setState((current) => ({
			data: current.data,
			loading: current.loading,
			saving: true,
			error: undefined,
		}))

		try {
			const data = await updateRuntimeOpsToolsets(toolsets)
			toolsetsCache = data
			setState({ data, loading: false, saving: false, error: undefined })
			return data
		} catch (error) {
			const nextError = error instanceof Error ? error : new Error('保存 ops toolsets 失败')
			setState((current) => ({
				data: current.data,
				loading: current.loading,
				saving: false,
				error: nextError,
			}))
			throw nextError
		}
	}, [])

	useEffect(() => {
		const cached = toolsetsCache
		setState({ data: cached, loading: !cached, saving: false, error: undefined })
		void doFetch(false, cached)
	}, [doFetch])

	return {
		...state,
		refetch: useCallback(async () => {
			invalidateRuntimeOpsToolsetsCache()
			await doFetch(true, stateRef.current.data)
		}, [doFetch]),
		update,
	}
}
