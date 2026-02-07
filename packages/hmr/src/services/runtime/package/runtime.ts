import { pathToFileURL } from 'node:url'

import type { Context } from '@pluxel/core'
import { normalize as normalizePath } from 'pathe'

import type { NormalizedPackageSpecifier, PackageLoadResult } from './types'

interface CachedModule {
	moduleId: string
	module: Record<string, unknown>
}

export class PackageRuntime {
	private readonly moduleCache = new Map<string, CachedModule>()
	private readonly moduleIds = new Map<string, string>()
	private readonly normalizeModuleIdImpl: (moduleId: string) => string
	private readonly hmr: Context['root']['hmrService']

	constructor(private readonly ctx: Context) {
		this.hmr = this.ctx.root.hmrService
		this.normalizeModuleIdImpl = this.hmr.normalizeId.bind(this.hmr)
	}

	normalizeModuleId(moduleId: string): string {
		return this.normalizeModuleIdImpl(moduleId)
	}

	getModuleId(name: string): string | undefined {
		return this.moduleIds.get(name)
	}

	clearModuleId(name: string) {
		this.moduleIds.delete(name)
	}

	bindModuleId(name: string, moduleId: string): string {
		const normalized = this.normalizeModuleId(moduleId)
		const current = this.moduleIds.get(name)
		if (current && current !== normalized) {
			this.moduleCache.delete(current)
			this.ctx.loader.pruneModule(current, 'runtime')
		}
		this.moduleIds.set(name, normalized)
		return normalized
	}

	getCachedModule(moduleId: string): CachedModule | undefined {
		return this.moduleCache.get(this.normalizeModuleId(moduleId))
	}

	setCachedModule(moduleId: string, module: Record<string, unknown>) {
		const normalized = this.normalizeModuleId(moduleId)
		this.moduleCache.set(normalized, { moduleId: normalized, module })
	}

	dropCachedModule(moduleId: string) {
		this.moduleCache.delete(this.normalizeModuleId(moduleId))
	}

	primeHmrModuleCache(
		spec: NormalizedPackageSpecifier,
		moduleId: string,
		module: Record<string, unknown>,
	) {
		const normalized = this.normalizeModuleId(moduleId)
		const ids = this.collectHmrModuleCacheIds(normalized, spec)
		const aliases = [...ids].filter((id) => id !== normalized)
		this.hmr.primeModuleCacheEntry({ id: normalized, exports: module, aliases })
	}

	dropHmrCacheForRecord(record: PackageLoadResult) {
		const ids = this.collectHmrModuleCacheIds(record.moduleId, record.spec)
		this.hmr.dropModuleCacheEntries(ids)
	}

	dropHmrCacheById(moduleId: string, alias?: string) {
		const normalized = this.normalizeModuleId(moduleId)
		const ids = new Set<string>([normalized])
		if (alias) ids.add(alias)
		this.hmr.dropModuleCacheEntries(ids)
	}

	private collectHmrModuleCacheIds(
		moduleId: string,
		spec: NormalizedPackageSpecifier,
	): Set<string> {
		const normalized = this.normalizeModuleId(moduleId)
		const ids = new Set<string>()
		for (const id of this.hmr.moduleIdAliases(normalized)) ids.add(id)
		ids.add(normalizePath(moduleId))
		ids.add(spec.name)
		ids.add(spec.target)
		ids.add(spec.raw)
		try {
			ids.add(pathToFileURL(normalized).href)
		} catch {
			// ignore invalid URL conversion
		}
		return ids
	}
}
