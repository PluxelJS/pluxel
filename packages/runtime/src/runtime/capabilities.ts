import {
	ForkablePlugin,
	formatForkPluginId,
	getPluginInfo,
	type ConfigLayout,
	type Context,
	type PluginConstructor,
} from '@pluxel/core'
import type { ConfigSchemaMap } from '@pluxel/core/services'
import { isPluginEnabled } from '../services/RuntimeStateStore'

export type RuntimePluginSource =
	| {
			__typename: 'PluginSourceInfo'
			kind: 'package'
			moduleId: string
			packageName: string
			version: string | null
			tag: string | null
	  }
	| {
			__typename: 'PluginSourceInfo'
			kind: 'hmr'
			moduleId: string
			packageName: null
			version: null
			tag: null
	  }
	| {
			__typename: 'PluginSourceInfo'
			kind: 'unknown'
			moduleId: null
			packageName: null
			version: null
			tag: null
	  }

export type RuntimePluginLifecycleStage = 'running' | 'stopped' | 'disabled'

export type RuntimePluginStatusSnapshot = {
	isRunning: boolean
	isEnabled: boolean
	lifecycleStage: RuntimePluginLifecycleStage
	source: RuntimePluginSource
}

export type RuntimePluginStatusOverview = {
	statuses: Array<RuntimePluginStatusSnapshot & { name: string }>
	summary: {
		total: number
		running: number
		stopped: number
		disabled: number
	}
}

export type RuntimePluginDependencyInfo = Array<{ name: string; isRunning: boolean }>

export interface PluginCatalogRead {
	resolve(target: PluginConstructor | string): PluginConstructor | undefined
	resolveOrRegistered(name: string): PluginConstructor | undefined
	require(name: string): PluginConstructor
	listRegistered(): ReadonlyMap<string, PluginConstructor>
	listLoadedNames(): readonly string[]
}

export interface PluginLifecycleControl {
	isRunning(target: PluginConstructor | string): boolean
	enable(name: string, ctor: PluginConstructor): Promise<void> | void
	enablePersisted(name: string): Promise<void> | void
	deactivate(name: string, ctor: PluginConstructor, options: { runtimeOnly: boolean }): void
	stop(name: string, ctor: PluginConstructor): void
}

export interface PluginConfigMetadataRead {
	getSchema(name: string): ConfigSchemaMap | undefined
	getSchemaSource(name: string): Readonly<Record<string, string>> | undefined
	getConfigLayout(name: string): Readonly<Record<string, ConfigLayout>> | undefined
}

export interface PluginDependencyRead {
	listDependencies(ctor: PluginConstructor): RuntimePluginDependencyInfo
	ensureForkBase(baseName: string): PluginConstructor | undefined
}

export interface PluginSourceRead {
	resolveSource(name: string, ctor?: PluginConstructor): RuntimePluginSource
}

export interface RuntimeModuleCacheEntry {
	id: string
	exports: Record<string, unknown>
	aliases?: readonly string[]
}

export interface RuntimeModuleRuntime {
	normalizeId(moduleId: string): string
	moduleIdAliases(moduleId: string): Iterable<string>
	primeModuleCacheEntry(entry: RuntimeModuleCacheEntry): void
	dropModuleCacheEntries(ids: Iterable<string>): void
}

export type RuntimeRouteCapabilities = {
	catalog: PluginCatalogRead
	lifecycle?: PluginLifecycleControl
	configMetadata?: PluginConfigMetadataRead
	dependencies?: PluginDependencyRead
	source?: PluginSourceRead
	modules?: RuntimeModuleRuntime
}

const identityModuleRuntime: RuntimeModuleRuntime = {
	normalizeId(moduleId) {
		return moduleId
	},
	moduleIdAliases(moduleId) {
		return [moduleId]
	},
	primeModuleCacheEntry() {},
	dropModuleCacheEntries() {},
}

declare module '@pluxel/core' {
	interface Context {
		runtimeRoute?: RuntimeRouteCapabilities
	}
}

export function requireRouteCapability<K extends keyof RuntimeRouteCapabilities>(
	ctx: Context,
	key: K,
): NonNullable<RuntimeRouteCapabilities[K]> {
	const value = ctx.runtimeRoute?.[key]
	if (!value) {
		throw new Error(`[pluxel/runtime] Runtime route capability "${key}" is not available.`)
	}
	return value
}

export function runtimeModuleRuntime(ctx: Context): RuntimeModuleRuntime {
	return ctx.runtimeRoute?.modules ?? ctx.root.runtimeRoute?.modules ?? identityModuleRuntime
}

export function unknownPluginSource(): RuntimePluginSource {
	return {
		__typename: 'PluginSourceInfo',
		kind: 'unknown',
		moduleId: null,
		packageName: null,
		version: null,
		tag: null,
	}
}

export function readRuntimePluginStatus(
	ctx: Context,
	name: string,
	ctor: PluginConstructor,
): RuntimePluginStatusSnapshot {
	const lifecycle = requireRouteCapability(ctx, 'lifecycle')
	const isRunning = lifecycle.isRunning(ctor)
	const isEnabled = isPluginEnabled(ctx.runtimeState.snapshot(), name)
	const lifecycleStage: RuntimePluginLifecycleStage = !isEnabled
		? 'disabled'
		: isRunning
			? 'running'
			: 'stopped'
	const source = ctx.runtimeRoute?.source?.resolveSource(name, ctor) ?? unknownPluginSource()
	return { isRunning, isEnabled, lifecycleStage, source }
}

export function runtimePluginStatusOverview(ctx: Context): RuntimePluginStatusOverview {
	const catalog = requireRouteCapability(ctx, 'catalog')
	const nameToCtor = catalog.listRegistered()
	const forkNames = new Set<string>()
	const persistedForks = ctx.runtimeState.snapshot().forks

	for (const [baseName, baseCtor] of nameToCtor) {
		const forkIds = persistedForks[baseName]
		if (Array.isArray(forkIds)) {
			for (const raw of forkIds) {
				const fid = typeof raw === 'string' ? raw.trim() : ''
				if (!fid) continue
				try {
					forkNames.add(formatForkPluginId(baseName, fid))
				} catch {}
			}
		}
		for (const forkCtor of ctx.registry.listForks(baseCtor as never)) {
			try {
				forkNames.add(getPluginInfo(forkCtor as never).id)
			} catch {}
		}
	}

	const allNames = [...new Set<string>([...nameToCtor.keys(), ...forkNames])].sort((a, b) =>
		a.localeCompare(b),
	)
	const statuses: Array<RuntimePluginStatusSnapshot & { name: string }> = []
	for (const name of allNames) {
		const ctor = catalog.resolve(name) ?? nameToCtor.get(name)
		if (!ctor) continue
		statuses.push({ name, ...readRuntimePluginStatus(ctx, name, ctor) })
	}

	let running = 0
	let disabled = 0
	for (const entry of statuses) {
		if (entry.isRunning) running += 1
		if (entry.isEnabled === false) disabled += 1
	}

	return {
		statuses,
		summary: {
			total: statuses.length,
			running,
			disabled,
			stopped: statuses.length - running - disabled,
		},
	}
}

export function ensureForkBaseFromCatalog(
	ctx: Context,
	baseName: string,
): PluginConstructor | undefined {
	const baseCtor = requireRouteCapability(ctx, 'catalog').resolve(baseName)
	if (!baseCtor) return undefined
	const proto = (baseCtor as { prototype?: unknown }).prototype
	if (!proto || !(proto instanceof ForkablePlugin)) return undefined
	return baseCtor
}
