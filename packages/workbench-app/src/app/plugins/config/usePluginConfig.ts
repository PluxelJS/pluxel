import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import type { PluginNodeAddressSnapshot } from '@pluxel/core'
import type { ObjectSchema } from 'valibot'
import * as v from 'valibot'
import * as f from 'valibot-form'

import { getPluginConfig, getPluginSchema, invokeRpc } from '../../../runtime'
import { stringifyUnknown } from '../../../utils/unknown'
import { workbenchNodeKey } from '../../../workbench/node-address'

export type PluginConfigData = {
	fieldName: string
	schema?: ObjectSchema<any, any>
	defaults: Record<string, unknown>
	savedConfig: Record<string, unknown>
	sections: readonly PluginConfigSection[]
}

export type PluginConfigSection = Readonly<{
	path: readonly string[]
	fieldName: string
	schema: ObjectSchema<any, any>
	defaults: Record<string, unknown>
}>

export type PluginConfigState = {
	data?: PluginConfigData
	loading: boolean
	error?: Error
	refetch: () => Promise<void>
}

type PluginConfigSnapshot = Omit<PluginConfigState, 'refetch'>

const EMPTY_CONFIG_SNAPSHOT: PluginConfigSnapshot = { loading: false }
const PLUGIN_CONFIG_TTL = 30_000
const configResources = new Map<string, PluginConfigResource>()

function evaluateSchemaSource(displayName: string, expr: string): ObjectSchema<any, any> {
	try {
		return new Function('v', 'f', `return ${expr}`)(v, f) as ObjectSchema<any, any>
	} catch (error) {
		throw new Error(
			`配置 schema 加载失败：${displayName} 无法还原（${stringifyUnknown(error, 'Unknown error')}）。schemaSource 只能引用运行时注入的 v/f。`,
			{ cause: error },
		)
	}
}

async function loadPluginConfigData(
	owner: PluginNodeAddressSnapshot,
	displayName: string,
	forceSchemaRefresh: boolean,
	current?: Omit<PluginConfigData, 'savedConfig'>,
): Promise<PluginConfigData> {
	return invokeRpc(async (rpc) => {
		const [schemaResult, configResult] = await Promise.all([
			forceSchemaRefresh || !current ? getPluginSchema(rpc, owner) : null,
			getPluginConfig(rpc, owner),
		])
		if (configResult.ok === false) {
			throw new Error(configResult.message ?? configResult.code ?? '配置加载失败')
		}
		const savedConfig = configResult.config ?? {}
		if (current) return { ...current, savedConfig }
		if (!schemaResult) throw new Error('schema 加载失败')
		if (schemaResult.ok === false) {
			if (schemaResult.code === 'schema_not_found') {
				return { fieldName: '', defaults: {}, savedConfig, sections: [] }
			}
			throw new Error(schemaResult.message ?? schemaResult.code)
		}
		return {
			fieldName: schemaResult.fieldName,
			schema: evaluateSchemaSource(displayName, schemaResult.schemaSource),
			defaults: schemaResult.defaults ?? {},
			savedConfig,
			sections: (schemaResult.sections ?? []).map((section) => ({
				path: section.path,
				fieldName: section.fieldName,
				schema: evaluateSchemaSource(
					`${displayName}:${section.path.join('.') || 'general'}`,
					section.schemaSource,
				),
				defaults: section.defaults ?? {},
			})),
		}
	})
}

class PluginConfigResource {
	private snapshot: PluginConfigSnapshot = { loading: true }
	private readonly listeners = new Set<() => void>()
	private inflight: Promise<void> | null = null
	private requestVersion = 0
	private loadedAt = 0

	constructor(
		readonly owner: PluginNodeAddressSnapshot,
		readonly displayName: string,
	) {}

	readonly subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	readonly getSnapshot = (): PluginConfigSnapshot => this.snapshot

	load(forceSchemaRefresh = false): Promise<void> {
		if (this.inflight !== null) return this.inflight
		if (
			!forceSchemaRefresh &&
			this.snapshot.data &&
			Date.now() - this.loadedAt < PLUGIN_CONFIG_TTL
		) {
			return Promise.resolve()
		}
		const version = ++this.requestVersion
		this.setSnapshot({ data: this.snapshot.data, loading: true })
		const current = this.snapshot.data
			? {
					fieldName: this.snapshot.data.fieldName,
					schema: this.snapshot.data.schema,
					defaults: this.snapshot.data.defaults,
					sections: this.snapshot.data.sections,
				}
			: undefined
		const task = loadPluginConfigData(this.owner, this.displayName, forceSchemaRefresh, current)
			.then((data): undefined => {
				if (version !== this.requestVersion) return undefined
				this.loadedAt = Date.now()
				this.setSnapshot({ data, loading: false })
				return undefined
			})
			.catch((error: unknown) => {
				if (version !== this.requestVersion) return
				this.setSnapshot({
					data: this.snapshot.data,
					loading: false,
					error: error instanceof Error ? error : new Error('加载失败'),
				})
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
		this.setSnapshot({ data: { ...this.snapshot.data, savedConfig }, loading: false })
	}

	invalidateSchema(): void {
		this.requestVersion += 1
		this.loadedAt = 0
		this.inflight = null
		this.setSnapshot({ loading: true })
		if (this.listeners.size > 0) void this.load(true)
	}

	private setSnapshot(next: PluginConfigSnapshot): void {
		this.snapshot = next
		for (const listener of this.listeners) listener()
	}
}

function getConfigResource(
	owner: PluginNodeAddressSnapshot,
	displayName: string,
): PluginConfigResource {
	const key = workbenchNodeKey(owner)
	let resource = configResources.get(key)
	if (!resource) {
		resource = new PluginConfigResource(owner, displayName)
		configResources.set(key, resource)
	}
	return resource
}

export function commitPluginConfig(
	owner: PluginNodeAddressSnapshot,
	displayName: string,
	savedConfig: Record<string, unknown>,
): void {
	getConfigResource(owner, displayName).commit(savedConfig)
}

if (import.meta.hot) {
	import.meta.hot.on('vite:beforeUpdate', () => {
		for (const resource of configResources.values()) resource.invalidateSchema()
	})
}

export function usePluginConfig(
	owner: PluginNodeAddressSnapshot | undefined,
	displayName = owner?.definition.exportName ?? '',
): PluginConfigState {
	const resource = useMemo(
		() => (owner ? getConfigResource(owner, displayName) : null),
		[owner, displayName],
	)
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
