import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import * as v from 'valibot'
import * as f from 'valibot-form'

import { getPluginConfig, getPluginSchema, invokeRpc } from '../../../runtime'
import type { ManagementMarkdownPart as BuiltinMarkdownPart } from '@pluxel/runtime/management'

export type PluginConfigData = {
	schemaMap: Record<string, any>
	/** schema 默认值 */
	defaults: Record<string, any>
	/** 已保存的配置（来自 configService） */
	savedConfig: Record<string, any>
	/** optional cfg layout (host-rendered) */
	layout?: BuiltinMarkdownPart[] | null
}

export type PluginConfigState = {
	data?: PluginConfigData
	loading: boolean
	error?: Error
	refetch: () => Promise<void>
}

type PluginSchemaData = Omit<PluginConfigData, 'savedConfig'>
type PluginConfigSnapshot = Omit<PluginConfigState, 'refetch'>

const EMPTY_CONFIG_SNAPSHOT: PluginConfigSnapshot = { loading: false }
const PLUGIN_CONFIG_TTL = 30_000
const configResources = new Map<string, PluginConfigResource>()

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message
	return String(error)
}

function evaluateSchemaSource(pluginName: string, key: string, expr: string): unknown {
	try {
		return new Function('v', 'f', `return ${expr}`)(v, f)
	} catch (error) {
		throw new Error(
			`配置 schema 加载失败：${pluginName}.${key} 无法还原（${errorMessage(error)}）。schemaSource 只能引用运行时注入的 v/f；请避免本地 helper 闭包。`,
			{ cause: error },
		)
	}
}

async function loadPluginData(
	pluginName: string,
	forceSchemaRefresh: boolean,
	currentSchema?: PluginSchemaData,
): Promise<PluginConfigData> {
	const cachedSchema = forceSchemaRefresh ? undefined : currentSchema

	return invokeRpc(async (rpc) => {
		const schemaPromise = cachedSchema ? null : getPluginSchema(rpc, pluginName)
		const configPromise = getPluginConfig(rpc, pluginName)
		const [schemaResult, configResult] = await Promise.all([schemaPromise, configPromise])
		if (configResult.ok === false) {
			throw new Error(configResult.message ?? configResult.code ?? '配置加载失败')
		}
		const savedConfig = (configResult.config ?? {}) as Record<string, any>

		if (cachedSchema) return { ...cachedSchema, savedConfig }
		if (!schemaResult) throw new Error('schema 加载失败')
		if (schemaResult.ok === false) {
			if (schemaResult.code === 'schema_not_found') {
				const schema: PluginSchemaData = { schemaMap: {}, defaults: {}, layout: null }
				return { ...schema, savedConfig }
			}
			throw new Error(schemaResult.message ?? schemaResult.code)
		}

		const schemaMap: Record<string, any> = {}
		const pending: Promise<void>[] = []
		for (const [key, expr] of Object.entries(schemaResult.schemaSource)) {
			if (key.startsWith('_')) continue
			const schema = evaluateSchemaSource(pluginName, key, expr)
			if (schema instanceof Promise) {
				pending.push(
					schema.then((resolved): undefined => {
						schemaMap[key] = resolved
						return undefined
					}),
				)
			} else {
				schemaMap[key] = schema
			}
		}
		if (pending.length > 0) await Promise.all(pending)

		const defaults: Record<string, any> = {}
		for (const key of Object.keys(schemaMap)) defaults[key] = (schemaResult.defaults ?? {})[key]
		const schema: PluginSchemaData = {
			schemaMap,
			defaults,
			layout: schemaResult.layout ?? null,
		}
		return { ...schema, savedConfig }
	})
}

class PluginConfigResource {
	private snapshot: PluginConfigSnapshot = { loading: true }
	private readonly listeners = new Set<() => void>()
	private inflight: Promise<void> | null = null
	private requestVersion = 0
	private loadedAt = 0

	constructor(readonly pluginName: string) {}

	readonly subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	readonly getSnapshot = (): PluginConfigSnapshot => this.snapshot

	load(forceSchemaRefresh = false): Promise<void> {
		if (this.inflight) return this.inflight
		if (
			!forceSchemaRefresh &&
			this.snapshot.data &&
			Date.now() - this.loadedAt < PLUGIN_CONFIG_TTL
		) {
			return Promise.resolve()
		}
		const version = ++this.requestVersion
		this.setSnapshot({ data: this.snapshot.data, loading: true })

		const currentSchema = this.snapshot.data
			? {
					schemaMap: this.snapshot.data.schemaMap,
					defaults: this.snapshot.data.defaults,
					layout: this.snapshot.data.layout,
				}
			: undefined
		const task = loadPluginData(this.pluginName, forceSchemaRefresh, currentSchema)
			.then((data): undefined => {
				if (version !== this.requestVersion) return undefined
				this.loadedAt = Date.now()
				this.setSnapshot({ data, loading: false })
				return undefined
			})
			.catch((error: unknown): undefined => {
				if (version !== this.requestVersion) return undefined
				this.setSnapshot({
					data: this.snapshot.data,
					loading: false,
					error: error instanceof Error ? error : new Error('加载失败'),
				})
				return undefined
			})
			.finally(() => {
				if (this.inflight === task) this.inflight = null
			})

		this.inflight = task
		return task
	}

	commit(savedConfig: Record<string, unknown>): void {
		if (!this.snapshot.data) return
		this.requestVersion += 1
		this.loadedAt = Date.now()
		this.setSnapshot({
			data: { ...this.snapshot.data, savedConfig },
			loading: false,
		})
	}

	invalidateSchema(): void {
		this.requestVersion += 1
		this.loadedAt = 0
		this.inflight = null
		this.setSnapshot({ loading: true })
		if (this.listeners.size > 0) void this.load(true)
	}

	private setSnapshot(next: PluginConfigSnapshot): void {
		if (
			this.snapshot.data === next.data &&
			this.snapshot.loading === next.loading &&
			this.snapshot.error === next.error
		) {
			return
		}
		this.snapshot = next
		for (const listener of this.listeners) listener()
	}
}

function getConfigResource(pluginName: string): PluginConfigResource {
	let resource = configResources.get(pluginName)
	if (!resource) {
		resource = new PluginConfigResource(pluginName)
		configResources.set(pluginName, resource)
	}
	return resource
}

export function commitPluginConfig(pluginName: string, savedConfig: Record<string, unknown>): void {
	getConfigResource(pluginName).commit(savedConfig)
}

function invalidatePluginConfigResources(): void {
	for (const resource of configResources.values()) resource.invalidateSchema()
}

if (import.meta.hot) {
	import.meta.hot.on('vite:beforeUpdate', () => invalidatePluginConfigResources())
}

export function usePluginConfig(pluginName: string | undefined): PluginConfigState {
	const resource = useMemo(() => (pluginName ? getConfigResource(pluginName) : null), [pluginName])
	const snapshot = useSyncExternalStore(
		resource?.subscribe ?? noopSubscribe,
		resource?.getSnapshot ?? getEmptySnapshot,
		resource?.getSnapshot ?? getEmptySnapshot,
	)

	useEffect(() => {
		if (resource) void resource.load(false)
	}, [resource])

	const refetch = useCallback(async () => {
		if (resource) await resource.load(true)
	}, [resource])

	return { ...snapshot, refetch }
}

function noopSubscribe(): () => void {
	return () => undefined
}

function getEmptySnapshot(): PluginConfigSnapshot {
	return EMPTY_CONFIG_SNAPSHOT
}
