import { useCallback, useEffect, useRef, useState } from 'react'
import * as v from 'valibot'
import * as f from 'valibot-form'
import { client } from '../../../rpc'

export type PluginConfigData = {
	schemaMap: Record<string, any>
	/** schema 默认值 */
	defaults: Record<string, any>
	/** 已保存的配置（来自 configService） */
	savedConfig: Record<string, any>
}

export type PluginConfigState = {
	data?: PluginConfigData
	loading: boolean
	error?: Error
	refetch: () => Promise<void>
}

// Schema 缓存（按插件名）
const schemaCache = new Map<string, { schemaMap: Record<string, any>; defaults: Record<string, any> }>()

/** 清除缓存 */
export function invalidateSchemaCache(pluginName?: string) {
	if (pluginName) schemaCache.delete(pluginName)
	else schemaCache.clear()
}

// HMR 自动失效（前端代码变更时）
if (import.meta.hot) {
	import.meta.hot.on('vite:beforeUpdate', () => invalidateSchemaCache())
}

/** 通过 REST API 加载 schema（带缓存） */
async function loadSchema(pluginName: string, forceRefresh = false) {
	if (!forceRefresh) {
		const cached = schemaCache.get(pluginName)
		if (cached) return cached
	}

	const res = await client.plugins[':name'].schema.$get({ param: { name: pluginName } })
	const result = await res.json() as any
	if (!result.ok) {
		throw new Error(result.message ?? 'schema 加载失败')
	}

	// 将 schema 源代码转换为 valibot schema 对象
	const schemaMap: Record<string, any> = {}
	for (const [key, expr] of Object.entries(result.schemaSource as Record<string, string>)) {
		schemaMap[key] = new Function('v', 'f', `return ${expr}`)(v, f)
	}

	const payload = { schemaMap, defaults: result.defaults as Record<string, any> }
	schemaCache.set(pluginName, payload)
	return payload
}

/** 通过 REST API 加载已保存的配置 */
async function loadSavedConfig(pluginName: string): Promise<Record<string, any>> {
	const res = await client.plugins[':name'].config.$get({ param: { name: pluginName } })
	const result = await res.json() as any
	return result.ok ? (result.config as Record<string, any>) : {}
}

export function usePluginConfig(pluginName: string | undefined): PluginConfigState {
	const [state, setState] = useState<{ data?: PluginConfigData; loading: boolean; error?: Error }>({
		data: undefined,
		loading: !!pluginName,
		error: undefined,
	})
	const abortRef = useRef<AbortController | null>(null)

	const doFetch = useCallback(async (forceRefresh = false) => {
		if (!pluginName) return
		abortRef.current?.abort()
		const ctrl = (abortRef.current = new AbortController())

		setState((s) => ({ ...s, loading: true, error: undefined }))

		try {
			const [schema, savedConfig] = await Promise.all([
				loadSchema(pluginName, forceRefresh),
				loadSavedConfig(pluginName),
			])
			if (ctrl.signal.aborted) return
			setState({ data: { ...schema, savedConfig }, loading: false, error: undefined })
		} catch (e) {
			if (ctrl.signal.aborted) return
			setState((s) => ({ ...s, loading: false, error: e instanceof Error ? e : new Error('加载失败') }))
		}
	}, [pluginName])

	useEffect(() => {
		if (!pluginName) {
			setState({ data: undefined, loading: false, error: undefined })
			return undefined
		}
		void doFetch()
		return () => abortRef.current?.abort()
	}, [pluginName, doFetch])

	// 暴露的 refetch 强制刷新缓存
	const refetch = useCallback(() => doFetch(true), [doFetch])

	return { ...state, refetch }
}
