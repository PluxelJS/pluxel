import { fileURLToPath } from 'node:url'
import type { Context } from '@pluxel/core'
import { makeIdFiltersToMatchWithQuery } from '@rolldown/pluginutils'
import { dirname, isAbsolute, resolve } from 'pathe'
import { createFilter, normalizePath } from 'vite'
import { findNearestPackageRoot } from './internals'

const DRIVE_PATH_RE = /^[a-zA-Z]:[\\/]/

function resolveCacheLimit(raw: unknown, fallback: number) {
	if (typeof raw === 'number' && Number.isFinite(raw)) return Math.max(0, Math.floor(raw))
	if (typeof raw === 'string') {
		const n = Number.parseInt(raw, 10)
		if (Number.isFinite(n)) return Math.max(0, n)
	}
	return fallback
}

function boundedSet<K, V>(map: Map<K, V>, key: K, value: V, limit: number) {
	if (limit <= 0) return
	map.set(key, value)
	if (map.size <= limit) return
	const first = map.keys().next().value as K
	map.delete(first)
}

export class HmrPathResolver {
	private serverRoot = ''
	private resolveBaseDirs: string[]
	private readonly cwdNormalized: string
	private readonly cacheLimit: number
	private readonly cleanIdCache = new Map<string, string>()
	private readonly fallbackDirsCache = new Map<string, string[]>()

	constructor(
		cwd: string,
		private scanRootsAbs: string[],
		opts?: { cacheLimit?: number },
	) {
		this.cwdNormalized = normalizePath(cwd)
		this.cacheLimit = resolveCacheLimit(opts?.cacheLimit, 10_000)
		this.resolveBaseDirs = this.buildResolveBaseDirs()
	}

	setServerRoot(root: string) {
		this.serverRoot = this.toViteId(root)
		this.resolveBaseDirs = this.buildResolveBaseDirs()
		this.clearCaches()
	}

	updateScanRoots(roots: string[]) {
		this.scanRootsAbs = roots
		this.resolveBaseDirs = this.buildResolveBaseDirs()
		this.clearCaches()
	}

	toViteId(p: string) {
		return normalizePath(p)
	}

	cleanUrl(id: string) {
		const i = id.indexOf('?')
		return i >= 0 ? id.slice(0, i) : id
	}

	toCleanId(pOrId: string) {
		const raw = this.cleanUrl(pOrId)
		if (this.cacheLimit > 0) {
			const cached = this.cleanIdCache.get(raw)
			if (cached !== undefined) return cached
		}

		// Fast paths: most ids we see at runtime are already normalized Vite/moduleGraph ids.
		// Keep this branchy but allocation-light: avoid normalizePath() unless we must.
		if (raw.startsWith('\0')) {
			boundedSet(this.cleanIdCache, raw, raw, this.cacheLimit)
			return raw
		}

		if (raw.startsWith('file:')) {
			try {
				const asPath = normalizePath(fileURLToPath(raw))
				boundedSet(this.cleanIdCache, raw, asPath, this.cacheLimit)
				return asPath
			} catch {
				// fall through
			}
		}

		// Schemed ids (node:, data:, virtual:, etc.) are not filesystem paths.
		// Keep them intact to avoid incorrect rebasing to cwd/serverRoot.
		// (Exception: Windows drive paths contain ":" but are filesystem paths.)
		if (raw.includes(':') && !DRIVE_PATH_RE.test(raw) && !raw.startsWith('/')) {
			boundedSet(this.cleanIdCache, raw, raw, this.cacheLimit)
			return raw
		}

		if (raw.startsWith('/@fs/')) {
			const out = raw.slice('/@fs'.length)
			boundedSet(this.cleanIdCache, raw, out, this.cacheLimit)
			return out
		}
		if (raw.startsWith('/@')) {
			// /@id, /@vite, etc — keep as-is (already normalized).
			boundedSet(this.cleanIdCache, raw, raw, this.cacheLimit)
			return raw
		}

		// Absolute posix path — usually already normalized.
		// The only time we must rewrite is when Vite gives us URL paths like "/src/*"
		// that are under server root (hmr UI package), not host filesystem.
		if (
			raw.startsWith('/') &&
			!raw.includes('\\') &&
			!raw.includes('/./') &&
			!raw.includes('/../') &&
			!raw.endsWith('/.') &&
			!raw.endsWith('/..')
		) {
			let isKnownFsPath = raw.startsWith(this.cwdNormalized)
			if (!isKnownFsPath) {
				const roots = this.scanRootsAbs
				for (let i = 0; i < roots.length; i++) {
					const root = roots[i]!
					if (raw.startsWith(root)) {
						isKnownFsPath = true
						break
					}
				}
			}

			if (this.serverRoot && !raw.startsWith(this.serverRoot) && !isKnownFsPath) {
				const rebased = normalizePath(resolve(this.serverRoot, raw.slice(1)))
				boundedSet(this.cleanIdCache, raw, rebased, this.cacheLimit)
				return rebased
			}
			boundedSet(this.cleanIdCache, raw, raw, this.cacheLimit)
			return raw
		}

		const clean = this.toViteId(raw)

		let normalized = clean

		if (!isAbsolute(normalized) && !normalized.startsWith('\0')) {
			// Relative filesystem paths are always resolved against the host cwd.
			// Never resolve them against Vite's server root (which points to the HMR UI package),
			// otherwise host-provided "root-relative" startup entries like `packages/**` would be rebased
			// to `<hmr-package-root>/packages/**` and fail to load.
			normalized = normalizePath(resolve(this.cwdNormalized, normalized))
		}

		if (this.serverRoot && normalized.startsWith('/') && !normalized.startsWith(this.serverRoot)) {
			// `normalized` can be:
			// - a real filesystem absolute path: `/home/.../file.ts`
			// - a Vite virtual id: `/@id/...`, `/@vite/...`
			// - a Vite URL path under root: `/src/...`
			//
			// Only rebase URL paths like `/src/*` to the Vite root. Never rebase real FS paths.
			let isKnownFsPath = normalized.startsWith(this.cwdNormalized)
			if (!isKnownFsPath) {
				const roots = this.scanRootsAbs
				for (let i = 0; i < roots.length; i++) {
					const root = roots[i]!
					if (normalized.startsWith(root)) {
						isKnownFsPath = true
						break
					}
				}
			}
			if (!isKnownFsPath && !normalized.startsWith('/@')) {
				normalized = normalizePath(resolve(this.serverRoot, normalized.slice(1)))
			}
		}
		boundedSet(this.cleanIdCache, raw, normalized, this.cacheLimit)
		return normalized
	}

	prettyId(pOrId: string) {
		const clean = this.toCleanId(pOrId)
		if (clean.startsWith(this.cwdNormalized))
			return clean.slice(this.cwdNormalized.length).replace(/^\/+/, '')
		return clean
	}

	moduleIdVariants(pOrId: string): string[] {
		const canonical = this.toCleanId(pOrId)
		return this.moduleIdVariantsClean(canonical)
	}

	moduleIdVariantsClean(cleanId: string): string[] {
		if (!cleanId.startsWith('/')) return [cleanId]
		const fs = `/@fs${cleanId}`
		if (this.serverRoot && cleanId.startsWith(this.serverRoot)) {
			const rel = cleanId.slice(this.serverRoot.length)
			const relId = rel.startsWith('/') ? rel : `/${rel}`
			if (relId !== cleanId && relId !== fs) return [cleanId, fs, relId]
		}
		return [cleanId, fs]
	}

	computeFallbackResolveDirs(importer?: string | null): string[] {
		if (!importer || !importer.startsWith('/')) return this.resolveBaseDirs

		const importerDir = dirname(importer)
		const cached = this.fallbackDirsCache.get(importerDir)
		if (cached) return cached

		const bases = new Set<string>(this.resolveBaseDirs)
		if (importer?.startsWith('/')) {
			bases.add(importerDir)
			const pkgRoot = findNearestPackageRoot(importerDir)
			if (pkgRoot) {
				bases.add(pkgRoot)
				bases.add(normalizePath(resolve(pkgRoot, 'node_modules')))
			}
		}
		const out = [...bases]
		boundedSet(this.fallbackDirsCache, importerDir, out, 500)
		return out
	}

	get cwdNormalizedPath() {
		return this.cwdNormalized
	}

	getServerRoot() {
		return this.serverRoot
	}

	private buildResolveBaseDirs(): string[] {
		const bases = new Set<string>([this.cwdNormalized])
		for (const dir of this.scanRootsAbs) bases.add(dir)
		if (this.serverRoot) bases.add(this.serverRoot)
		return [...bases]
	}

	private clearCaches() {
		this.cleanIdCache.clear()
		this.fallbackDirsCache.clear()
	}
}

export interface HmrPathApi {
	toClean: (id: string) => string
	toVite: (id: string) => string
	pretty: (id: string) => string
	variants: (id: string) => string[]
	/**
	 * Fast-path for ids that are already clean (canonical ids used inside HMR pipeline).
	 * This avoids re-running `toClean()` inside `variants()`.
	 */
	variantsClean?: (cleanId: string) => string[]
}

export interface HmrToolkit {
	path: HmrPathApi
	pathFilter: (id: string) => boolean
}

type HmrFilterFactory = (raw: string) => boolean

/**
 * 封装 HMR 运行时环境：路径规范化、过滤器、裸模块解析等，集中对外暴露 toolkit。
 */
export class HmrEnvironment {
	private pathFilterImpl: HmrFilterFactory
	private scanRootsAbs: string[]
	private readonly includeGlobs?: string[]
	private readonly excludeGlobs?: string[]

	public readonly paths: HmrPathResolver
	public readonly toolkit: HmrToolkit

	constructor(
		private readonly ctx: Context,
		opts: {
			cwd: string
			scanRootsAbs: string[]
			includeGlobs?: string[]
			excludeGlobs?: string[]
			pathCacheLimit?: number
		},
	) {
		this.scanRootsAbs = [...opts.scanRootsAbs]
		this.includeGlobs = opts.includeGlobs
		this.excludeGlobs = opts.excludeGlobs
		this.paths = new HmrPathResolver(opts.cwd, this.scanRootsAbs, {
			cacheLimit: opts.pathCacheLimit,
		})
		this.pathFilterImpl = this.createFilters()
		this.toolkit = {
			path: {
				toClean: (id: string) => this.normalizeId(id),
				toVite: (id: string) => this.paths.toViteId(id),
				pretty: (id: string) => this.paths.prettyId(id),
				variants: (id: string) => this.paths.moduleIdVariants(id),
				variantsClean: (cleanId: string) => this.paths.moduleIdVariantsClean(cleanId),
			},
			pathFilter: (id) => this.pathFilter(id),
		}
	}

	setServerRoot(root: string) {
		this.paths.setServerRoot(root)
		this.pathFilterImpl = this.createFilters()
	}

	updateScanRoots(roots: string[]) {
		this.scanRootsAbs = [...roots]
		this.paths.updateScanRoots(this.scanRootsAbs)
		this.pathFilterImpl = this.createFilters()
	}

	normalizeId(id: string) {
		// Hot path: once ids have been normalized to filesystem-clean ids (scan roots / cwd),
		// avoid re-normalizing (query stripping, cache lookups, rebasing).
		if (this.isProbablyCleanId(id)) return id
		return this.paths.toCleanId(id)
	}

	pathFilter(raw: string) {
		if (this.isProbablyCleanId(raw)) return this.pathFilterImpl(raw)
		const clean = this.normalizeId(raw)
		return this.pathFilterImpl(clean)
	}

	private isProbablyCleanId(id: string) {
		if (!id) return false
		if (id.includes('\\')) return false
		if (id.includes('?')) return false
		if (id.startsWith('/@')) return false
		if (id.startsWith('\0')) return true
		if (!id.startsWith('/')) return false
		// If there are traversal segments, always normalize to avoid subtle module id mismatches.
		if (id.includes('/./') || id.includes('/../') || id.endsWith('/.') || id.endsWith('/..'))
			return false
		if (id.startsWith(this.paths.cwdNormalizedPath)) return true
		const roots = this.scanRootsAbs
		for (let i = 0; i < roots.length; i++) {
			const root = roots[i]!
			if (id.startsWith(root)) return true
		}
		return false
	}

	private createFilters(): HmrFilterFactory {
		const exts = ['ts', 'tsx', 'mts', 'cts'] as const
		const includeGlobs = makeIdFiltersToMatchWithQuery(
			this.includeGlobs?.length
				? this.includeGlobs
				: this.scanRootsAbs.flatMap((dir) => exts.map((ext) => `${dir}/**/*.${ext}`)),
		)
		const excludePatterns = this.scanRootsAbs.flatMap((dir) => [`${dir}/**/*.d.ts`])
		const excludeGlobs = makeIdFiltersToMatchWithQuery([
			...excludePatterns,
			...(this.excludeGlobs ?? []),
			'**/node_modules/**',
		])
		const baseFilter = createFilter(includeGlobs, excludeGlobs)

		return (cleanId: string) => (cleanId.includes('/node_modules/') ? false : baseFilter(cleanId))
	}
}
