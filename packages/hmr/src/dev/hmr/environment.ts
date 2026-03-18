import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { makeIdFiltersToMatchWithQuery } from '@rolldown/pluginutils'
import { dirname, isAbsolute, resolve } from 'pathe'
import { createFilter, normalizePath } from 'vite'
import {
	DRIVE_PATH_RE,
	boundedSet,
	cleanViteUrl,
	findNearestPackageRoot,
	fsPathFromViteFsId,
	resolveCacheLimit,
	toViteFsIdVariants,
	tryRealpathSync,
} from '@pluxel/runtime/shared'

type RootAlias = { from: string; to: string }
type FsExists = (fsPath: string) => boolean

export class HmrPathResolver {
	private serverRoot = ''
	private resolveBaseDirs: string[]
	private readonly cwdNormalized: string
	private readonly cacheLimit: number
	private readonly fsExists: FsExists
	private readonly cleanIdCache = new Map<string, string>()
	private readonly fallbackDirsCache = new Map<string, string[]>()
	private readonly realpathCache = new Map<string, string>()
	private rootAliases: RootAlias[] = []

	constructor(
		cwd: string,
		scanRootsAbs: string[],
		opts?: { cacheLimit?: number; fsExists?: FsExists },
	) {
		this.cwdNormalized = normalizePath(tryRealpathSync(cwd))
		this.cacheLimit = resolveCacheLimit(opts?.cacheLimit, 10_000)
		this.fsExists = opts?.fsExists ?? existsSync
		this.scanRootsAbs = []
		this.setScanRoots(scanRootsAbs)
		this.resolveBaseDirs = this.buildResolveBaseDirs()
	}

	private scanRootsAbs: string[]

	setServerRoot(root: string) {
		this.serverRoot = this.toViteId(root)
		this.resolveBaseDirs = this.buildResolveBaseDirs()
		this.clearCaches()
	}

	updateScanRoots(roots: string[]) {
		this.setScanRoots(roots)
		this.resolveBaseDirs = this.buildResolveBaseDirs()
		this.clearCaches()
	}

	get scanRootsCanonical() {
		return this.scanRootsAbs
	}

	canonicalizeCleanId(id: string) {
		if (!id || !id.startsWith('/')) return id
		if (id.startsWith('/@') || id.startsWith('\0')) return id
		return this.canonicalizeFsPath(id)
	}

	toViteId(p: string) {
		return normalizePath(p)
	}

	toCleanId(pOrId: string) {
		const raw = cleanViteUrl(pOrId)
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
				const canonical = this.canonicalizeFsPath(asPath)
				boundedSet(this.cleanIdCache, raw, canonical, this.cacheLimit)
				return canonical
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
			const out = fsPathFromViteFsId(raw) ?? raw.slice('/@fs'.length)
			const canonical = this.canonicalizeFsPath(out)
			boundedSet(this.cleanIdCache, raw, canonical, this.cacheLimit)
			return canonical
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
			const isKnownFsPath = this.isKnownFsPath(raw)

			if (this.serverRoot && !raw.startsWith(this.serverRoot) && !isKnownFsPath) {
				const rebased = normalizePath(resolve(this.serverRoot, raw.slice(1)))
				const picked = this.preferExistingPath(rebased, raw)
				const canonical = this.canonicalizeFsPath(picked)
				boundedSet(this.cleanIdCache, raw, canonical, this.cacheLimit)
				return canonical
			}
			if (this.fsExists(raw)) {
				const canonical = this.canonicalizeFsPath(raw)
				boundedSet(this.cleanIdCache, raw, canonical, this.cacheLimit)
				return canonical
			}
			// Likely a Vite root-relative URL path (e.g. `/src/*`); preserve as-is.
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
			const isKnownFsPath = this.isKnownFsPath(normalized)
			if (!isKnownFsPath && !normalized.startsWith('/@')) {
				const rebased = normalizePath(resolve(this.serverRoot, normalized.slice(1)))
				normalized = this.preferExistingPath(rebased, normalized)
			}
		}
		if (normalized.startsWith('/') || DRIVE_PATH_RE.test(normalized)) {
			const canonical = this.canonicalizeFsPath(normalized)
			boundedSet(this.cleanIdCache, raw, canonical, this.cacheLimit)
			return canonical
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
		const out: string[] = [cleanId]
		// Only add `/@fs/` aliases for real filesystem paths.
		// (Never produce nonsense aliases for Vite virtual ids like `/@id/...`.)
		if (
			(cleanId.startsWith('/') && !cleanId.startsWith('/@')) ||
			(DRIVE_PATH_RE.test(cleanId) && !cleanId.startsWith('/'))
		) {
			for (const v of toViteFsIdVariants(cleanId)) {
				if (v !== cleanId) out.push(v)
			}
		}

		if (this.serverRoot && cleanId.startsWith(this.serverRoot)) {
			const rel = cleanId.slice(this.serverRoot.length)
			const relId = rel.startsWith('/') ? rel : `/${rel}`
			if (relId !== cleanId) out.push(relId)
		}

		return out
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

	private setScanRoots(roots: string[]) {
		const canonicalRoots: string[] = []
		const aliases: RootAlias[] = []
		for (const r of roots) {
			if (!r) continue
			const abs = normalizePath(isAbsolute(r) ? r : resolve(this.cwdNormalized, r))
			const canonical = normalizePath(tryRealpathSync(abs))
			canonicalRoots.push(canonical)
			if (canonical !== abs) aliases.push({ from: abs, to: canonical })
		}
		// De-dupe while keeping order stable.
		this.scanRootsAbs = [...new Set(canonicalRoots)]
		// Prefer the longest-prefix match to avoid partial rewrites when roots nest.
		this.rootAliases = aliases.sort((a, b) => b.from.length - a.from.length)
	}

	private applyRootAliases(fsPath: string) {
		for (const alias of this.rootAliases) {
			if (fsPath === alias.from) return alias.to
			if (fsPath.startsWith(`${alias.from}/`)) {
				return `${alias.to}${fsPath.slice(alias.from.length)}`
			}
		}
		return fsPath
	}

	private realpathCached(fsPath: string) {
		const cached = this.realpathCache.get(fsPath)
		if (cached !== undefined) return cached
		const resolved = normalizePath(tryRealpathSync(fsPath))
		boundedSet(this.realpathCache, fsPath, resolved, Math.min(this.cacheLimit, 10_000))
		return resolved
	}

	private canonicalizeFsPath(fsPath: string) {
		let out = normalizePath(fsPath)
		out = this.applyRootAliases(out)
		// Canonicalize to physical filesystem paths to avoid evaluating the same file under
		// both symlink and realpath ids (Vite config uses `preserveSymlinks: false`).
		out = this.realpathCached(out)
		out = this.applyRootAliases(out)
		return out
	}

	private preferExistingPath(rebased: string, original: string) {
		if (this.fsExists(rebased)) return rebased
		if (this.fsExists(original)) return original
		return rebased
	}

	private isKnownFsPath(fsPath: string) {
		if (fsPath.startsWith(this.cwdNormalized)) return true
		const roots = this.scanRootsAbs
		for (let i = 0; i < roots.length; i++) {
			const root = roots[i]!
			if (fsPath.startsWith(root)) return true
		}
		return false
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
		this.realpathCache.clear()
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

	constructor(opts: {
		cwd: string
		scanRootsAbs: string[]
		includeGlobs?: string[]
		excludeGlobs?: string[]
		pathCacheLimit?: number
	}) {
		this.scanRootsAbs = []
		this.includeGlobs = opts.includeGlobs
		this.excludeGlobs = opts.excludeGlobs
		this.paths = new HmrPathResolver(opts.cwd, opts.scanRootsAbs, {
			cacheLimit: opts.pathCacheLimit,
		})
		this.scanRootsAbs = [...this.paths.scanRootsCanonical]
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
		this.paths.updateScanRoots(roots)
		this.scanRootsAbs = [...this.paths.scanRootsCanonical]
		this.pathFilterImpl = this.createFilters()
	}

	normalizeId(id: string) {
		// Hot path: once ids have been normalized to filesystem-clean ids (scan roots / cwd),
		// avoid re-normalizing (query stripping, cache lookups, rebasing).
		if (this.isProbablyCleanId(id)) return this.paths.canonicalizeCleanId(id)
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
		const excludePatterns = this.scanRootsAbs.flatMap((dir) => [
			`${dir}/**/*.d.ts`,
			`${dir}/**/*.d.mts`,
			`${dir}/**/*.d.cts`,
		])
		const excludeGlobs = makeIdFiltersToMatchWithQuery([
			...excludePatterns,
			...(this.excludeGlobs ?? []),
			'**/node_modules/**',
		])
		const baseFilter = createFilter(includeGlobs, excludeGlobs)

		return (cleanId: string) => (cleanId.includes('/node_modules/') ? false : baseFilter(cleanId))
	}
}
