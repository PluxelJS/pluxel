import {
	ForkablePlugin,
	getPluginInfo,
	pluginNodeAddressOf,
	type Context,
	type PluginConfigDefinition,
	type PluginConstructor,
	type PluginDefinitionAddressSnapshot,
	type PluginNodeAddressSnapshot,
} from '@pluxel/core'
import { isPluginEnabled, listForkIds } from '../services/RuntimeStateStore'
import { pluginNodeAddressKey } from './plugin-address'

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

export type RuntimePluginCatalogEntry = Readonly<{
	address: PluginNodeAddressSnapshot
	ctor: PluginConstructor
	displayName: string
	rootExportName: string
}>

export type RuntimePluginStatusSnapshot = {
	address: PluginNodeAddressSnapshot
	displayName: string
	rootExportName: string
	isRunning: boolean
	isEnabled: boolean
	lifecycleStage: RuntimePluginLifecycleStage
	source: RuntimePluginSource
}

export type RuntimePluginStatusOverview = {
	statuses: RuntimePluginStatusSnapshot[]
	summary: { total: number; running: number; stopped: number; disabled: number }
}

export type RuntimePluginDependencyInfo = Array<{
	address: PluginNodeAddressSnapshot
	displayName: string
	isRunning: boolean
}>

export interface PluginCatalogRead {
	resolve(address: PluginNodeAddressSnapshot): PluginConstructor | undefined
	resolveDefinition(address: PluginDefinitionAddressSnapshot): PluginConstructor | undefined
	require(address: PluginNodeAddressSnapshot): PluginConstructor
	listRegistered(): readonly RuntimePluginCatalogEntry[]
}

export interface PluginLifecycleControl {
	isRunning(address: PluginNodeAddressSnapshot): boolean
	enable(address: PluginNodeAddressSnapshot, ctor?: PluginConstructor): Promise<void> | void
	enablePersisted(address: PluginNodeAddressSnapshot): Promise<void> | void
	deactivate(
		address: PluginNodeAddressSnapshot,
		ctor: PluginConstructor,
		options: { runtimeOnly: boolean },
	): void
	stop(address: PluginNodeAddressSnapshot, ctor: PluginConstructor): void
}

export interface PluginConfigMetadataRead {
	getConfig(address: PluginNodeAddressSnapshot): PluginConfigDefinition | undefined
}

export interface PluginDependencyRead {
	listDependencies(address: PluginNodeAddressSnapshot): RuntimePluginDependencyInfo
	ensureForkBase(definition: PluginDefinitionAddressSnapshot): PluginConstructor | undefined
}

export interface PluginSourceRead {
	resolveSource(address: PluginNodeAddressSnapshot, ctor?: PluginConstructor): RuntimePluginSource
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
	dynamicPluginSources?: {
		hasFile(path: string): boolean
		hasDirectory(path: string, include: readonly string[]): boolean
	}
}

const identityModuleRuntime: RuntimeModuleRuntime = {
	normalizeId: (moduleId) => moduleId,
	moduleIdAliases: (moduleId) => [moduleId],
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
	if (!value)
		throw new Error(`[pluxel/runtime] Runtime route capability "${key}" is not available.`)
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
	entry: RuntimePluginCatalogEntry,
): RuntimePluginStatusSnapshot {
	const lifecycle = requireRouteCapability(ctx, 'lifecycle')
	const isRunning = lifecycle.isRunning(entry.address)
	const isEnabled = isPluginEnabled(ctx.runtimeState.snapshot(), entry.address)
	const lifecycleStage: RuntimePluginLifecycleStage = !isEnabled
		? 'disabled'
		: isRunning
			? 'running'
			: 'stopped'
	const source =
		ctx.runtimeRoute?.source?.resolveSource(entry.address, entry.ctor) ?? unknownPluginSource()
	return {
		address: entry.address,
		displayName: entry.displayName,
		rootExportName: entry.rootExportName,
		isRunning,
		isEnabled,
		lifecycleStage,
		source,
	}
}

export function runtimePluginStatusOverview(ctx: Context): RuntimePluginStatusOverview {
	const catalog = requireRouteCapability(ctx, 'catalog')
	const entries = new Map<string, RuntimePluginCatalogEntry>()
	for (const entry of catalog.listRegistered())
		entries.set(pluginNodeAddressKey(entry.address), entry)

	for (const base of entries.values()) {
		for (const forkId of listForkIds(ctx.runtimeState.snapshot(), base.address.definition)) {
			const ctor = ctx.registry.fork(base.ctor as never, forkId) as PluginConstructor
			const address = pluginNodeAddressOf(ctor)
			entries.set(pluginNodeAddressKey(address), {
				address,
				ctor,
				displayName: getPluginInfo(ctor).displayName,
				rootExportName: base.rootExportName,
			})
		}
		for (const ctor of ctx.registry.listForks(base.ctor as never)) {
			const address = pluginNodeAddressOf(ctor)
			entries.set(pluginNodeAddressKey(address), {
				address,
				ctor,
				displayName: getPluginInfo(ctor).displayName,
				rootExportName: base.rootExportName,
			})
		}
	}

	const statuses = [...entries.values()]
		.map((entry) => readRuntimePluginStatus(ctx, entry))
		.sort((left, right) =>
			pluginNodeAddressKey(left.address).localeCompare(pluginNodeAddressKey(right.address)),
		)
	let running = 0
	let disabled = 0
	for (const entry of statuses) {
		if (entry.isRunning) running++
		if (!entry.isEnabled) disabled++
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
	definition: PluginDefinitionAddressSnapshot,
): PluginConstructor | undefined {
	const baseCtor = requireRouteCapability(ctx, 'catalog').resolveDefinition(definition)
	if (!baseCtor) return undefined
	const proto = (baseCtor as { prototype?: unknown }).prototype
	return proto && proto instanceof ForkablePlugin ? baseCtor : undefined
}
