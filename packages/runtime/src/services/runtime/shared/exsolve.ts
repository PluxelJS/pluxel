import { pathToFileURL } from 'node:url'
import type { createResolver } from 'exsolve'
import { getOrCreateCachedValue } from './cache'
import { toPosixPath } from './fs-path'

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
	const normalized = toPosixPath(inputPath)
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
	return getOrCreateCachedValue(store, key, create, { limit: opts?.limit ?? 32 })
}
