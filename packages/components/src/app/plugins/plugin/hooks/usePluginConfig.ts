import { useCallback, useEffect, useRef, useState } from 'react'
import { client } from '../../../rpc'

export type PluginConfigResponse = {
	config?: Record<string, any>
	existConfig?: Record<string, any>
}

export type PluginConfigState = {
	data?: PluginConfigResponse
	loading: boolean
	error?: Error
	refetch: () => Promise<void>
}

const configCache = new Map<string, PluginConfigResponse>()

export function usePluginConfig(pluginName: string | undefined): PluginConfigState {
	const [state, setState] = useState<{
		data?: PluginConfigResponse
		loading: boolean
		error?: Error
	}>(() => ({
		data: pluginName ? configCache.get(pluginName) : undefined,
		loading: Boolean(pluginName && !configCache.has(pluginName)),
		error: undefined,
	}))
	const abortRef = useRef<AbortController | null>(null)

	const fetchConfig = useCallback(
		async (signal?: AbortSignal) => {
			if (!pluginName) return undefined
			const res = await client.plugins[':name'].config.$get(
				{ param: { name: pluginName } },
				{ init: { signal } },
			)
			if (!res.ok) throw new Error('获取插件配置出错')
			return (await res.json()) as PluginConfigResponse
		},
		[pluginName],
	)

	const startFetch = useCallback(async () => {
		if (!pluginName) return

		abortRef.current?.abort()
		const controller = new AbortController()
		abortRef.current = controller

		setState((prev) => ({
			data: prev.data ?? configCache.get(pluginName),
			loading: true,
			error: undefined,
		}))

		try {
			const data = await fetchConfig(controller.signal)
			if (controller.signal.aborted) return
			if (data) configCache.set(pluginName, data)
			setState({ data, loading: false, error: undefined })
		} catch (error: any) {
			if (controller.signal.aborted) return
			setState((prev) => ({
				...prev,
				loading: false,
				error: error instanceof Error ? error : new Error('加载插件配置失败'),
			}))
		}
	}, [fetchConfig, pluginName])

	useEffect(() => {
		if (!pluginName) {
			setState({ data: undefined, loading: false, error: undefined })
			return () => {}
		}

		const cached = configCache.get(pluginName)
		setState({ data: cached, loading: !cached, error: undefined })
		void startFetch()

		return () => {
			abortRef.current?.abort()
		}
	}, [pluginName, startFetch])

	const refetch = useCallback(async () => {
		await startFetch()
	}, [startFetch])

	return {
		data: state.data,
		loading: state.loading,
		error: state.error,
		refetch,
	}
}
