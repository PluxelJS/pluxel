import { type Context } from '@pluxel/core'
import { makeIdFiltersToMatchWithQuery } from '@rolldown/pluginutils'
import { dirname, isAbsolute, resolve } from 'pathe'
import { createFilter, normalizePath } from 'vite'
import { findNearestPackageRoot } from './internals'
import { resolveBareImport } from './workspace-resolver'

export class HmrPathResolver {
	private serverRoot = ''
	private resolveBaseDirs: string[]
	private readonly cwdNormalized: string

	constructor(
		private readonly cwd: string,
		private scanRootsAbs: string[],
	) {
		this.cwdNormalized = normalizePath(cwd)
		this.resolveBaseDirs = this.buildResolveBaseDirs()
	}

	setServerRoot(root: string) {
		this.serverRoot = this.toViteId(root)
		this.resolveBaseDirs = this.buildResolveBaseDirs()
	}

	updateScanRoots(roots: string[]) {
		this.scanRootsAbs = roots
		this.resolveBaseDirs = this.buildResolveBaseDirs()
	}

	toViteId(p: string) {
		return normalizePath(p)
	}

	cleanUrl(id: string) {
		const i = id.indexOf('?')
		return i >= 0 ? id.slice(0, i) : id
	}

	toCleanId(pOrId: string) {
		const clean = this.cleanUrl(this.toViteId(pOrId))
		let normalized = clean.replace(/^\/@fs\//, '/')

		if (!isAbsolute(normalized) && !normalized.startsWith('\0')) {
			const base = this.serverRoot || this.cwdNormalized
			normalized = normalizePath(resolve(base, normalized))
		}

		if (this.serverRoot && normalized.startsWith('/') && !normalized.startsWith(this.serverRoot)) {
			normalized = normalizePath(resolve(this.serverRoot, normalized.slice(1)))
		}
		return normalized
	}

	prettyId(pOrId: string) {
		const clean = this.toCleanId(pOrId)
		if (clean.startsWith(this.cwdNormalized))
			return clean.slice(this.cwdNormalized.length).replace(/^\\\//, '')
		return clean
	}

	moduleIdVariants(pOrId: string): string[] {
		const canonical = this.toCleanId(pOrId)
		const variants = new Set<string>([canonical])

		if (canonical.startsWith('/')) {
			variants.add(`/@fs${canonical}`)
			if (this.serverRoot && canonical.startsWith(this.serverRoot)) {
				const rel = canonical.slice(this.serverRoot.length)
				const relWithSlash = rel.startsWith('/') ? rel : `/${rel}`
				variants.add(relWithSlash)
			}
		}

		return [...variants]
	}

	computeFallbackResolveDirs(importer?: string | null): string[] {
		const bases = new Set<string>(this.resolveBaseDirs)
		if (importer && importer.startsWith('/')) {
			const importerDir = dirname(importer)
			bases.add(importerDir)
			const pkgRoot = findNearestPackageRoot(importerDir)
			if (pkgRoot) {
				bases.add(pkgRoot)
				bases.add(normalizePath(resolve(pkgRoot, 'node_modules')))
			}
		}
		return [...bases]
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
}

export interface HmrPathApi {
	toClean: (id: string) => string
	toVite: (id: string) => string
	pretty: (id: string) => string
	variants: (id: string) => string[]
}

export interface HmrToolkit {
	path: HmrPathApi
	pathFilter: (id: string) => boolean
	resolveBareModule: (specifier: string, importer?: string | null) => Promise<string | null>
}

const DRIVE_PATH_RE = /^[a-zA-Z]:[\\/]/
type HmrFilterFactory = (raw: string) => boolean

/**
 * 封装 HMR 运行时环境：路径规范化、过滤器、裸模块解析等，集中对外暴露 toolkit。
 */
export class HmrEnvironment {
	private pathFilterImpl: HmrFilterFactory
	private readonly workspaceConditions: readonly string[]
	private scanRootsAbs: string[]

	public readonly paths: HmrPathResolver
	public readonly toolkit: HmrToolkit

	constructor(
		private readonly ctx: Context,
		opts: {
			cwd: string
			scanRootsAbs: string[]
			workspaceConditions: readonly string[]
		},
	) {
		this.workspaceConditions = [...opts.workspaceConditions]
		this.scanRootsAbs = [...opts.scanRootsAbs]
		this.paths = new HmrPathResolver(opts.cwd, this.scanRootsAbs)
		this.pathFilterImpl = this.createFilters()
		this.toolkit = {
			path: {
				toClean: (id: string) => this.normalizeId(id),
				toVite: (id: string) => this.paths.toViteId(id),
				pretty: (id: string) => this.paths.prettyId(id),
				variants: (id: string) => this.paths.moduleIdVariants(id),
			},
			pathFilter: (id) => this.pathFilter(id),
			resolveBareModule: (specifier, importer) => this.resolveBareModule(specifier, importer),
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
		return this.paths.toCleanId(id)
	}

	pathFilter(raw: string) {
		const clean = this.normalizeId(raw)
		return this.pathFilterImpl(clean)
	}

	private createFilters(): HmrFilterFactory {
		const includeGlobs = makeIdFiltersToMatchWithQuery(
			this.scanRootsAbs.flatMap((dir) => [`${dir}/**/*.ts`]),
		)
		const excludePatterns = this.scanRootsAbs.flatMap((dir) => [
			`${dir}/**/*.d.ts`,
			`${dir}/**/*.tsx`,
			`${dir}/**/node_modules/**`,
		])
		const excludeGlobs = makeIdFiltersToMatchWithQuery([...excludePatterns, '**/node_modules/**'])
		const baseFilter = createFilter(includeGlobs, excludeGlobs)

		return (raw: string) => {
			const id = this.paths.toCleanId(raw)
			const anchorSet = new Set<string>()
			for (const a of this.ctx.loader.pathAnchors ?? []) anchorSet.add(this.paths.toCleanId(a))
			if (anchorSet.has(id)) return true
			if (id.includes('/node_modules/')) return false
			return baseFilter(id)
		}
	}

	private isBareImport(id: string | undefined) {
		if (!id) return false
		if (id.startsWith('.') || id.startsWith('/') || id.startsWith('\0')) return false
		if (DRIVE_PATH_RE.test(id)) return false
		return true
	}

	async resolveBareModule(specifier: string, importer?: string | null) {
		if (!this.isBareImport(specifier)) return null
		const normalizedImporter = importer ? this.normalizeId(importer) : importer
		return (
			(await resolveBareImport({
				specifier,
				importer: normalizedImporter,
				scanService: this.ctx.scanService,
				conditions: this.workspaceConditions,
				fallbackBaseDirs: this.paths.computeFallbackResolveDirs(normalizedImporter ?? undefined),
			})) ?? null
		)
	}
}
