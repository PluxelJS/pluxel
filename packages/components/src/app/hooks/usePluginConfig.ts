import { useCallback, useEffect, useRef, useState } from 'react'
import * as v from 'valibot'
import * as f from 'valibot-form'

import { createRpcClient } from '../rpc'

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
const schemaCache = new Map<
	string,
	{ schemaMap: Record<string, any>; defaults: Record<string, any> }
>()

/** 清除缓存 */
export function invalidateSchemaCache(pluginName?: string) {
	if (pluginName) schemaCache.delete(pluginName)
	else schemaCache.clear()
}

// HMR 自动失效（前端代码变更时）
if (import.meta.hot) {
	import.meta.hot.on('vite:beforeUpdate', () => invalidateSchemaCache())
}

/** 一次性加载插件的 schema 和 config（自动 batch） */
async function loadPluginData(
	pluginName: string,
	forceRefresh = false,
): Promise<{
	schemaMap: Record<string, any>
	defaults: Record<string, any>
	savedConfig: Record<string, any>
}> {
	const cachedSchema = forceRefresh ? null : schemaCache.get(pluginName)

	// 同一个 session 内的调用会被 capnweb 自动 batch
	using rpc = createRpcClient()
	const p = rpc.plugin(pluginName)

	// 发起调用（不 await），capnweb 会在 Promise.all 时 batch 发送
	const schemaPromise = cachedSchema ? null : p.schema()
	const configPromise = p.config()

	const [schemaResult, configResult] = await Promise.all([schemaPromise, configPromise])
	const savedConfig = configResult.ok ? (configResult.config as Record<string, any>) : {}

	if (cachedSchema) return { ...cachedSchema, savedConfig }

	if (!schemaResult) throw new Error('schema 加载失败')
	if (schemaResult.ok === false) {
		// schema_not_found 代表插件未暴露配置 schema，此时视为“没有可配置项”而不是错误
		if (schemaResult.code === 'schema_not_found') {
			const payload = { schemaMap: {}, defaults: {} }
			schemaCache.set(pluginName, payload)
			return { ...payload, savedConfig }
		}
		throw new Error(schemaResult.message ?? schemaResult.code)
	}

	// 转换 schema 表达式
	const schemaMap: Record<string, any> = {}
	const pending: Promise<void>[] = []

	for (const [key, expr] of Object.entries(schemaResult.schemaSource)) {
		const schema = new Function('v', 'f', `return ${expr}`)(v, f)
		if (schema instanceof Promise) {
			pending.push(
				schema.then((r) => {
					schemaMap[key] = r
				}),
			)
		} else {
			schemaMap[key] = schema
		}
	}
	if (pending.length) await Promise.all(pending)

	const payload = { schemaMap, defaults: schemaResult.defaults }
	schemaCache.set(pluginName, payload)
	return { ...payload, savedConfig }
}

export function usePluginConfig(pluginName: string | undefined): PluginConfigState {
	const [state, setState] = useState<{ data?: PluginConfigData; loading: boolean; error?: Error }>({
		data: undefined,
		loading: !!pluginName,
		error: undefined,
	})
	const abortRef = useRef<AbortController | null>(null)

	const doFetch = useCallback(
		async (forceRefresh = false) => {
			if (!pluginName) return
			abortRef.current?.abort()
			const ctrl = (abortRef.current = new AbortController())

			setState({ data: undefined, loading: true, error: undefined })

			try {
				const data = await loadPluginData(pluginName, forceRefresh)
				if (ctrl.signal.aborted) return
				setState({ data, loading: false, error: undefined })
			} catch (e) {
				if (ctrl.signal.aborted) return
				setState({
					data: undefined,
					loading: false,
					error: e instanceof Error ? e : new Error('加载失败'),
				})
			}
		},
		[pluginName],
	)

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
