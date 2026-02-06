import { pathToFileURL } from 'node:url'
import type { createResolver } from 'exsolve'
import { normalizePath } from 'vite'

export type ExsolveCache = Map<string, unknown>
export type ExsolveResolver = ReturnType<typeof createResolver>

const GLOBAL_EXSOLVE_CACHE: ExsolveCache = new Map()
const resolverGroupsByCache = new WeakMap<ExsolveCache, Map<string, Map<string, ExsolveResolver>>>()

export function getExsolveCache(cache?: ExsolveCache): ExsolveCache {
	return cache ?? GLOBAL_EXSOLVE_CACHE
}

function getResolverGroup(cache: ExsolveCache, group: string): Map<string, ExsolveResolver> {
	let groups = resolverGroupsByCache.get(cache)
	if (!groups) {
		groups = new Map()
		resolverGroupsByCache.set(cache, groups)
	}

	let store = groups.get(group)
	if (!store) {
		store = new Map()
		groups.set(group, store)
	}
	return store
}

export function toDirectoryURLString(inputPath: string): string {
	const normalized = normalizePath(inputPath)
	const asDir = normalized.endsWith('/') ? normalized : `${normalized}/`
	return pathToFileURL(asDir).toString()
}

export function getCachedExsolveResolver(
	cache: ExsolveCache,
	group: string,
	key: string,
	create: () => ExsolveResolver,
	opts?: { limit?: number },
): ExsolveResolver {
	const store = getResolverGroup(cache, group)
	const cached = store.get(key)
	if (cached) {
		// Refresh insertion order so eviction behaves like a tiny LRU.
		store.delete(key)
		store.set(key, cached)
		return cached
	}

	const resolver = create()
	store.set(key, resolver)

	const limit = opts?.limit ?? 32
	if (limit > 0 && store.size > limit) {
		const first = store.keys().next()
		if (!first.done) store.delete(first.value)
	}

	return resolver
}
