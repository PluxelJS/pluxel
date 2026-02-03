import { fileURLToPath, pathToFileURL } from 'node:url'

import type { Context } from '@pluxel/core'
import { normalize as normalizePath } from 'pathe'

import type { NormalizedPackageSpecifier, PackageLoadResult } from './types'

interface CachedModule {
	moduleId: string
	module: Record<string, unknown>
}

type HmrServiceLike = {
	normalizeId?: (x: string) => string
	primeModuleCacheEntry?: (args: {
		id: string
		exports: Record<string, unknown>
		aliases: string[]
	}) => void
	dropModuleCacheEntries?: (ids: Set<string>) => void
	moduleIdAliases?: (normalized: string) => Iterable<string>
}

type RootLike = {
	root?: unknown
	hmrService?: HmrServiceLike
}

const FS_PREFIX = '/@fs/'

function normalizeModuleIdFallback(moduleId: string): string {
	if (!moduleId) return moduleId
	if (moduleId.startsWith('\0')) return moduleId
	if (moduleId.startsWith('file://')) {
		try {
			return normalizePath(fileURLToPath(moduleId))
		} catch {
			return moduleId
		}
	}
	if (moduleId.startsWith(FS_PREFIX)) return normalizePath(moduleId.slice(FS_PREFIX.length))
	if (moduleId.startsWith('/@')) return moduleId
	return normalizePath(moduleId)
}

export class PackageRuntime {
	private readonly moduleCache = new Map<string, CachedModule>()
	private readonly moduleIds = new Map<string, string>()
	private readonly normalizeModuleIdImpl: (moduleId: string) => string

	constructor(private readonly ctx: Context) {
		const root = ((this.ctx as unknown as RootLike).root ?? this.ctx) as RootLike
		const hmr = root.hmrService
		this.normalizeModuleIdImpl =
			typeof hmr?.normalizeId === 'function' ? hmr.normalizeId.bind(hmr) : normalizeModuleIdFallback
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
		const root = ((this.ctx as unknown as RootLike).root ?? this.ctx) as RootLike
		const hmr = root.hmrService
		if (!hmr?.primeModuleCacheEntry) return
		const normalized = this.normalizeModuleId(moduleId)
		const ids = this.collectHmrModuleCacheIds(normalized, spec)
		const aliases = [...ids].filter((id) => id !== normalized)
		hmr.primeModuleCacheEntry({ id: normalized, exports: module, aliases })
	}

	dropHmrCacheForRecord(record: PackageLoadResult) {
		const root = ((this.ctx as unknown as RootLike).root ?? this.ctx) as RootLike
		const hmr = root.hmrService
		if (!hmr?.dropModuleCacheEntries) return
		const ids = this.collectHmrModuleCacheIds(record.moduleId, record.spec)
		hmr.dropModuleCacheEntries(ids)
	}

	dropHmrCacheById(moduleId: string, alias?: string) {
		const root = ((this.ctx as unknown as RootLike).root ?? this.ctx) as RootLike
		const hmr = root.hmrService
		if (!hmr?.dropModuleCacheEntries) return
		const normalized = this.normalizeModuleId(moduleId)
		const ids = new Set<string>([normalized])
		if (alias) ids.add(alias)
		hmr.dropModuleCacheEntries(ids)
	}

	private collectHmrModuleCacheIds(
		moduleId: string,
		spec: NormalizedPackageSpecifier,
	): Set<string> {
		const normalized = this.normalizeModuleId(moduleId)
		const ids = new Set<string>()
		const root = ((this.ctx as unknown as RootLike).root ?? this.ctx) as RootLike
		const hmr = root.hmrService
		if (hmr?.moduleIdAliases) {
			for (const id of hmr.moduleIdAliases(normalized)) ids.add(id)
		} else {
			ids.add(normalized)
		}
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
