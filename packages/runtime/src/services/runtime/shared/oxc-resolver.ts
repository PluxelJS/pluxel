import { fileURLToPath, pathToFileURL } from 'node:url'
import { ResolverFactory, type NapiResolveOptions } from 'oxc-resolver'
import { dirname, normalize, resolve } from 'pathe'
import { getOrCreateCachedValue } from './cache'

export type OxcResolveCache = Map<string, unknown>
export interface OxcResolveHit {
	path: string
	packageJsonPath?: string
	moduleType?: string
}
export type OxcResolveOptions = { try?: boolean; conditions?: readonly string[] }
export type OxcResolver = {
	resolveModule(request: string, options?: OxcResolveOptions): OxcResolveHit | undefined
	resolveModulePath(request: string, options?: OxcResolveOptions): string | undefined
	clearCache(): void
}

const GLOBAL_OXC_RESOLVE_CACHE: OxcResolveCache = new Map()
const RESOLVER_CACHE_PREFIX = '\0pluxel:oxc-resolver:'

export function getOxcResolveCache(cache?: OxcResolveCache): OxcResolveCache {
	return cache ?? GLOBAL_OXC_RESOLVE_CACHE
}

export function clearOxcResolveCache(cache: OxcResolveCache) {
	for (const value of cache.values()) {
		if (value instanceof Map) {
			for (const resolver of value.values()) {
				if (isOxcResolver(resolver)) resolver.clearCache()
			}
		}
	}
	cache.clear()
}

function isOxcResolver(value: unknown): value is OxcResolver {
	return Boolean(
		value &&
			typeof value === 'object' &&
			'clearCache' in value &&
			typeof (value as { clearCache?: unknown }).clearCache === 'function',
	)
}

function getResolverGroup(cache: OxcResolveCache, group: string): Map<string, OxcResolver> {
	const key = `${RESOLVER_CACHE_PREFIX}${group}`
	const cached = cache.get(key)
	if (cached instanceof Map) return cached as Map<string, OxcResolver>

	const store = new Map<string, OxcResolver>()
	cache.set(key, store)
	return store
}

export function normalizeOxcResolveDirectories(from: readonly string[]): string[] {
	const out: string[] = []
	const seen = new Set<string>()
	for (const item of from) {
		const normalized = normalizeResolveBase(item)
		if (!normalized || seen.has(normalized)) continue
		seen.add(normalized)
		out.push(normalized)
	}
	return out
}

export function toDirectoryURLString(inputPath: string): string {
	const normalized = normalize(inputPath)
	const asDir = normalized.endsWith('/') ? normalized : `${normalized}/`
	return pathToFileURL(asDir).toString()
}

export function getCachedOxcResolver(
	cache: OxcResolveCache,
	group: string,
	key: string,
	create: () => OxcResolver,
	opts?: { limit?: number },
): OxcResolver {
	const store = getResolverGroup(cache, group)
	return getOrCreateCachedValue(store, key, create, { limit: opts?.limit ?? 32 })
}

export function createOxcResolver(from: readonly string[]): OxcResolver {
	const directories = normalizeOxcResolveDirectories(from)
	const baseOptions = createResolverOptions()
	const baseFactory = new ResolverFactory(baseOptions)
	const factoriesByConditions = new Map<string, ResolverFactory>()

	const resolveModule = (
		request: string,
		options?: OxcResolveOptions,
	): OxcResolveHit | undefined => {
		const key = JSON.stringify([...(options?.conditions ?? [])])
		let factory = factoriesByConditions.get(key)
		if (!factory) {
			const conditions = options?.conditions ? [...options.conditions] : []
			factory =
				conditions.length === 0
					? baseFactory
					: baseFactory.cloneWithOptions(createResolverOptions(conditions))
			factoriesByConditions.set(key, factory)
		}

		let lastError: unknown
		for (const directory of directories) {
			try {
				const result = factory.sync(directory, request)
				if (result.path) {
					const hit: OxcResolveHit = { path: result.path }
					if (result.packageJsonPath) hit.packageJsonPath = result.packageJsonPath
					if (result.moduleType) hit.moduleType = result.moduleType
					return hit
				}
			} catch (error) {
				lastError = error
			}
		}

		if (options?.try !== true && lastError) throw lastError
		return undefined
	}

	return {
		resolveModule,
		resolveModulePath(request, options) {
			return resolveModule(request, options)?.path
		},
		clearCache() {
			baseFactory.clearCache()
			for (const factory of factoriesByConditions.values()) {
				if (factory !== baseFactory) factory.clearCache()
			}
			factoriesByConditions.clear()
		},
	}
}

export function resolvePackageJsonPathWithOxc(
	resolver: OxcResolver,
	packageName: string,
	options?: { conditions?: readonly string[] },
): string | null {
	const packageJson = resolver.resolveModule(`${packageName}/package.json`, {
		try: true,
		conditions: options?.conditions,
	})
	if (packageJson?.path) return packageJson.path

	const entry = resolver.resolveModule(packageName, {
		try: true,
		conditions: options?.conditions,
	})
	return entry?.packageJsonPath ?? null
}

function createResolverOptions(conditionNames: string[] = []): NapiResolveOptions {
	return {
		conditionNames,
		extensions: ['.ts', '.tsx', '.mts', '.mjs', '.js', '.jsx', '.cts', '.cjs', '.json', '.node'],
		mainFields: ['module', 'main'],
		moduleType: true,
		tsconfig: 'auto',
	}
}

function normalizeResolveBase(input: string): string | null {
	const raw = String(input ?? '').trim()
	if (!raw) return null

	if (raw.startsWith('file://')) {
		try {
			const fsPath = fileURLToPath(raw)
			const resolved = resolve(fsPath)
			return normalize(raw.endsWith('/') ? resolved : dirname(resolved))
		} catch {
			return null
		}
	}

	return normalize(resolve(raw))
}
