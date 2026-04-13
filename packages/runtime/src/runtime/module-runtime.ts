import type { Context } from '@pluxel/core'

export interface RuntimeModuleCacheEntry {
	id: string
	exports: Record<string, unknown>
	aliases?: readonly string[]
}

export interface RuntimeModuleAdapter {
	normalizeId(moduleId: string): string
	moduleIdAliases(moduleId: string): Iterable<string>
	primeModuleCacheEntry(entry: RuntimeModuleCacheEntry): void
	dropModuleCacheEntries(ids: Iterable<string>): void
}

const identityModuleRuntime: RuntimeModuleAdapter = {
	normalizeId(moduleId) {
		return moduleId
	},
	moduleIdAliases(moduleId) {
		return [moduleId]
	},
	primeModuleCacheEntry() {},
	dropModuleCacheEntries() {},
}

const store = new WeakMap<object, RuntimeModuleAdapter>()

export function getRuntimeModuleAdapter(ctx: Pick<Context, 'config'>): RuntimeModuleAdapter {
	return store.get(ctx as object) ?? identityModuleRuntime
}

export function hasRuntimeModuleAdapter(ctx: Pick<Context, 'config'>): boolean {
	return store.has(ctx as object)
}

export function setRuntimeModuleAdapter(
	ctx: Pick<Context, 'config'>,
	adapter: RuntimeModuleAdapter,
): void {
	store.set(ctx as object, adapter)
}

export function clearRuntimeModuleAdapter(ctx: Pick<Context, 'config'>): void {
	store.delete(ctx as object)
}

export function createHmrModuleRuntimeAdapter(
	hmr: Pick<
		{
			normalizeId(moduleId: string): string
			moduleIdAliases(moduleId: string): Iterable<string>
			primeModuleCacheEntry(entry: RuntimeModuleCacheEntry): void
			dropModuleCacheEntries(ids: Iterable<string>): void
		},
		'normalizeId' | 'moduleIdAliases' | 'primeModuleCacheEntry' | 'dropModuleCacheEntries'
	>,
): RuntimeModuleAdapter {
	return {
		normalizeId(moduleId) {
			return hmr.normalizeId(moduleId)
		},
		moduleIdAliases(moduleId) {
			return hmr.moduleIdAliases(moduleId)
		},
		primeModuleCacheEntry(entry) {
			hmr.primeModuleCacheEntry(entry)
		},
		dropModuleCacheEntries(ids) {
			hmr.dropModuleCacheEntries(ids)
		},
	}
}
