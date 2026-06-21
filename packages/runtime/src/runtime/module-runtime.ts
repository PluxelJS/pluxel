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

const store = new WeakMap<Context.Root, RuntimeModuleAdapter>()

export function getRuntimeModuleAdapter(ctx: Context): RuntimeModuleAdapter {
	return store.get(ctx.root) ?? identityModuleRuntime
}

export function hasRuntimeModuleAdapter(ctx: Context): boolean {
	return store.has(ctx.root)
}

export function setRuntimeModuleAdapter(ctx: Context, adapter: RuntimeModuleAdapter): void {
	store.set(ctx.root, adapter)
}

export function clearRuntimeModuleAdapter(ctx: Context): void {
	store.delete(ctx.root)
}
