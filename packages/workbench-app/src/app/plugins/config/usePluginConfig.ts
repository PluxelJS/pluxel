import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import { pluginNodeIndexKey, type PluginNodeAddress } from '@pluxel/core'
import type { FieldNode } from 'valibot-form'

import { type RuntimeManagementClient, useRuntimeManagementClient } from '../../../runtime'
import { adaptConfigPresentationFields } from './presentationAdapter'

export type PluginConfigData = {
	fieldName: string
	fields: readonly FieldNode[]
	defaults: Record<string, unknown>
	savedConfig: Record<string, unknown>
	sections: readonly PluginConfigSection[]
}

export type PluginConfigSection = Readonly<{
	path: readonly string[]
	fieldName: string
	fields: readonly FieldNode[]
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
const configResources = new WeakMap<RuntimeManagementClient, Map<string, PluginConfigResource>>()
const allConfigResources = new Set<PluginConfigResource>()

async function loadPluginConfigData(
	client: RuntimeManagementClient,
	owner: PluginNodeAddress,
	forcePresentationRefresh: boolean,
	current?: Omit<PluginConfigData, 'savedConfig'>,
): Promise<PluginConfigData> {
	const [presentationResult, configResult] = await Promise.all([
		forcePresentationRefresh || !current ? client.config.presentation(owner) : null,
		client.config.get(owner),
	])
	if (configResult.ok === false) {
		throw new Error(configResult.message ?? configResult.code ?? '配置加载失败')
	}
	const savedConfig = configResult.config ?? {}
	if (current) return { ...current, savedConfig }
	if (!presentationResult) throw new Error('配置展示计划加载失败')
	if (presentationResult.ok === false) {
		if (presentationResult.code === 'presentation_not_found') {
			return { fieldName: '', fields: [], defaults: {}, savedConfig, sections: [] }
		}
		throw new Error(presentationResult.message ?? presentationResult.code)
	}
	const presentation = presentationResult.plan
	return {
		fieldName: presentation.fieldName,
		fields: adaptConfigPresentationFields(presentation.fields),
		defaults: { ...presentation.defaults },
		savedConfig,
		sections: presentation.sections.map((section) => ({
			path: section.path,
			fieldName: section.fieldName,
			fields: adaptConfigPresentationFields(section.fields),
			defaults: { ...section.defaults },
		})),
	}
}

class PluginConfigResource {
	private snapshot: PluginConfigSnapshot = { loading: true }
	private readonly listeners = new Set<() => void>()
	private inflight: Promise<void> | null = null
	private requestVersion = 0
	private loadedAt = 0

	constructor(
		private readonly client: RuntimeManagementClient,
		readonly owner: PluginNodeAddress,
	) {}

	readonly subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	readonly getSnapshot = (): PluginConfigSnapshot => this.snapshot

	load(forcePresentationRefresh = false): Promise<void> {
		if (this.inflight !== null) return this.inflight
		if (
			!forcePresentationRefresh &&
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
					fields: this.snapshot.data.fields,
					defaults: this.snapshot.data.defaults,
					sections: this.snapshot.data.sections,
				}
			: undefined
		const task = loadPluginConfigData(this.client, this.owner, forcePresentationRefresh, current)
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

	refreshSavedConfig(): Promise<void> {
		this.loadedAt = 0
		return this.load(false)
	}

	invalidatePresentation(): void {
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
	client: RuntimeManagementClient,
	owner: PluginNodeAddress,
): PluginConfigResource {
	const key = pluginNodeIndexKey(owner)
	let resources = configResources.get(client)
	if (!resources) {
		resources = new Map()
		configResources.set(client, resources)
	}
	let resource = resources.get(key)
	if (!resource) {
		resource = new PluginConfigResource(client, owner)
		resources.set(key, resource)
		allConfigResources.add(resource)
	}
	return resource
}

export function commitPluginConfig(
	client: RuntimeManagementClient,
	owner: PluginNodeAddress,
	savedConfig: Record<string, unknown>,
): void {
	getConfigResource(client, owner).commit(savedConfig)
}

export async function refreshPluginConfig(
	client: RuntimeManagementClient,
	owner: PluginNodeAddress,
): Promise<void> {
	await getConfigResource(client, owner).refreshSavedConfig()
}

if (import.meta.hot) {
	import.meta.hot.on('vite:beforeUpdate', () => {
		for (const resource of allConfigResources) resource.invalidatePresentation()
	})
}

export function usePluginConfig(owner: PluginNodeAddress | undefined): PluginConfigState {
	const client = useRuntimeManagementClient()
	const resource = useMemo(() => (owner ? getConfigResource(client, owner) : null), [client, owner])
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
