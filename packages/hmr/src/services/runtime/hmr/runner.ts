import { existsSync } from 'node:fs'
import { readFile, realpath } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { getDebugLogger } from '@pluxel/core/logger'
import { dirname, resolve } from 'pathe'
import type { Plugin } from 'vite'
import { createServerModuleRunner, type DevEnvironment, type ViteDevServer } from 'vite'
import {
	ESModulesEvaluator,
	type EvaluatedModuleNode,
	EvaluatedModules,
	type ModuleRunner,
} from 'vite/module-runner'
import { clearSieveState, getOrCreatePromise, resolveCacheLimit } from '../shared/cache'
import {
	PLUXEL_DIST_EXPORT_CONDITIONS,
	PLUXEL_HMR_WORKSPACE_CONDITIONS_WITH_SOURCE,
} from '../shared/conditions'
import { type ExsolveResolver, getExsolveCache, toDirectoryURLString } from '../shared/exsolve'
import { getCachedResolver, resolveModulePath } from '../shared/resolution'
import {
	cleanViteUrl as cleanUrl,
	DRIVE_PATH_RE,
	fsPathFromViteFsId,
	isBarePackageSpecifier,
	unwrapViteId,
} from '../shared/vite-id'
import type { HmrPathApi } from './environment'
import { findNearestPackageRoot, matchesSpecifierPattern } from './internals'

export type PrimeModuleCacheEntryParams = {
	id: string
	exports: unknown
	aliases?: Iterable<string>
}

export type HmrRunnerInitOptions = {
	/** Internal cache limit for runner bookkeeping. Defaults to `10_000`. */
	cacheLimit?: number
	/**
	 * Host workspace cwd used as the primary resolution base for host exports.
	 *
	 * NOTE: Vite's dev server root points at the HMR UI package, not the host cwd.
	 * We still need a stable way to resolve "host-installed" packages, especially in linked repos.
	 */
	hostCwd?: string
	/** CJS-only specifiers/prefixes that must be executed via Node/require. */
	cjsExternal?: readonly string[]
	/** The Vite plugin that owns HMR resolveId hooks, skipped when resolving CJS externals to real files. */
	skipPlugin?: Plugin
	/** Modules that must be shared as host singletons (loaded by host and runner). */
	bridgeModules?: readonly string[]
	/** Optional bridge specifier → provider specifier mapping. */
	bridgeProviders?: Readonly<Record<string, string>>
	/** Optional shared exsolve cache map (recommended: share with ScanService). */
	resolveCache?: Map<string, unknown>
	/** Export conditions used when resolving workspace entries (source preference). */
	workspaceConditions?: readonly string[]
}

const HARD_BRIDGE_IDS = ['@pluxel/core', '@pluxel/hmr'] as const
const HARD_BRIDGE_PREFIXES = ['@pluxel/core/', '@pluxel/hmr/'] as const
const HARD_BRIDGE_ID_SET = new Set<string>(HARD_BRIDGE_IDS)
const dbgFetch = getDebugLogger('pluxel:hmr:fetch').with({ name: 'runner' })

type ExternalizeHint = {
	externalize: string
	type: 'module' | 'commonjs'
}

export class HmrRunner {
	public readonly evaluatedModules = new EvaluatedModules()

	private _env: DevEnvironment | null = null
	private _runner: ModuleRunner | null = null
	private _hostResolver!: ExsolveResolver
	private _hostCwdAbs: string | null = null
	private _cjsExternal: readonly string[] = []
	private _skipPlugin: Plugin | null = null
	private _bridgeModules: readonly string[] = []
	private _bridgeProviders: Readonly<Record<string, string>> = Object.freeze({})
	private _workspaceSourceConditions: string[] = []
	private _workspaceDistConditions: string[] = []
	private _cacheLimit = 10_000
	private realpathCache = new Map<string, Promise<string>>()
	private packageNameByPackageRoot = new Map<string, Promise<string | null>>()
	private packageNameByFile = new Map<string, Promise<string | null>>()
	private bridgedHostExports = new Map<string, unknown>()
	private bridgedRunnerUrls = new Set<string>()
	private workspaceEntryByKey = new Map<string, Promise<string | null>>()

	init(server: ViteDevServer, opts: HmrRunnerInitOptions = {}) {
		this._env = server.environments.ssr
		this._cacheLimit = resolveCacheLimit(opts.cacheLimit, 10_000)

		// Resolution base (in priority order):
		// - host cwd: resolve host-installed deps (workspace root node_modules)
		// - Vite root: resolve deps installed alongside the HMR UI package (when linked)
		// - this module: last-resort (pnpm workspace symlinks / direct execution)
		this._hostCwdAbs = resolve(opts.hostCwd ?? process.cwd())
		const viteRootAbs = resolve(server.config.root)
		const resolveCache = getExsolveCache(opts.resolveCache)
		const hostCwdUrl = toDirectoryURLString(this._hostCwdAbs)
		const viteRootUrl = toDirectoryURLString(viteRootAbs)
		const resolverFrom = [...new Set([hostCwdUrl, viteRootUrl, import.meta.url])]
		this._hostResolver = getCachedResolver(resolveCache, 'hmr:runner-resolver', resolverFrom, {
			limit: 8,
		})
		this._workspaceSourceConditions = opts.workspaceConditions?.length
			? [...opts.workspaceConditions]
			: [...PLUXEL_HMR_WORKSPACE_CONDITIONS_WITH_SOURCE]
		this._workspaceDistConditions = [...PLUXEL_DIST_EXPORT_CONDITIONS]
		const hasNativeSourcemapSupport =
			typeof (globalThis as unknown as { process?: { setSourceMapsEnabled?: unknown } })?.process
				?.setSourceMapsEnabled === 'function'
		this._runner = createServerModuleRunner(this.env, {
			hmr: false,
			evaluatedModules: this.evaluatedModules,
			// Prefer Node/Bun native sourcemap support when available; fall back to Vite's
			// prepareStackTrace interceptor (older runtimes / edge environments).
			sourcemapInterceptor: hasNativeSourcemapSupport ? 'node' : 'prepareStackTrace',
			// Ensure stack traces are aligned when running modules via AsyncFunction wrapper.
			// (ESModulesEvaluator applies the appropriate `startOffset` for inlined sourcemaps.)
			evaluator: new ESModulesEvaluator(),
		})

		this._cjsExternal = opts.cjsExternal ?? []
		this._skipPlugin = opts.skipPlugin ?? null
		this._bridgeProviders = opts.bridgeProviders ?? Object.freeze({})
		const baseBridgeModules = opts.bridgeModules ?? []
		const providerModules = Object.values(this._bridgeProviders).filter(
			(v): v is string => typeof v === 'string' && v.length > 0,
		)
		this._bridgeModules = providerModules.length
			? [...new Set([...baseBridgeModules, ...providerModules])]
			: baseBridgeModules
		this.installFetchModuleInterceptor()
	}

	get env(): DevEnvironment {
		if (!this._env) throw new Error('HmrRunner not initialized')
		return this._env
	}

	get runner(): ModuleRunner {
		if (!this._runner) throw new Error('HmrRunner not initialized')
		return this._runner
	}

	import(id: string) {
		const mapped = this._bridgeProviders[id] ?? id
		return this.runner.import(mapped)
	}

	primeModuleCacheEntry(params: PrimeModuleCacheEntryParams) {
		const urls = new Set<string>([params.id, ...(params.aliases ?? [])])
		for (const url of urls) {
			const node = this.evaluatedModules.ensureModule(params.id, url)
			if (!node.meta) node.meta = { id: node.id, url }
			setEvaluatedModuleExports(node, params.exports)
		}
	}

	dropModuleCacheEntries(ids: Iterable<string>) {
		for (const rawId of ids) {
			const byId = this.evaluatedModules.getModuleById(rawId)
			if (byId) {
				this.evaluatedModules.invalidateModule(byId)
				byId.importers.clear()
			}
			const byUrl = this.evaluatedModules.getModuleByUrl(rawId)
			if (byUrl) {
				this.evaluatedModules.invalidateModule(byUrl)
				byUrl.importers.clear()
			}
		}
	}

	invalidateRunnerCacheByFiles(files: Iterable<string>) {
		const invalidatedKeys: string[] = []
		let invalidated = 0
		const invalidatedNodes = new Set<EvaluatedModuleNode>()
		for (const file of files) {
			const nodes = this.evaluatedModules.getModulesByFile(file)
			if (!nodes?.size) continue
			for (const node of nodes) {
				if (invalidatedNodes.has(node)) continue
				invalidatedNodes.add(node)
				this.evaluatedModules.invalidateModule(node)
				node.importers.clear()
				invalidated++
				invalidatedKeys.push(node.id)
			}
		}
		return { invalidated, invalidatedKeys }
	}

	clearResolutionCaches() {
		this.workspaceEntryByKey.clear()
		clearSieveState(this.workspaceEntryByKey)
		this.realpathCache.clear()
		clearSieveState(this.realpathCache)
		this.packageNameByPackageRoot.clear()
		clearSieveState(this.packageNameByPackageRoot)
		this.packageNameByFile.clear()
		clearSieveState(this.packageNameByFile)
	}

	async bridgeHostModules(
		specifiers: readonly string[],
		path: HmrPathApi,
		logger: { warn: (message: string, props?: Record<string, unknown>) => void },
	) {
		const env = this.env
		const importerHint = (() => {
			const base = this._hostCwdAbs ?? env.config.root
			const p = resolve(base, 'package.json')
			return existsSync(p) ? p : undefined
		})()
		await Promise.all(
			specifiers.map(async (specifier) => {
				if (specifier.endsWith('/*')) return
				// Prefer using `env.fetchModule()` for ids, because in some Vite 8 beta flows
				// `pluginContainer.resolveId()` can return null for workspace packages even though the
				// module is otherwise resolvable during transform/evaluation.
				let fetchedUrl: string | null = null
				let fetchedId: string | null = null
				try {
					const fetched = await env.fetchModule(specifier, importerHint)
					const meta = fetched as { url?: unknown; id?: unknown } | null
					fetchedUrl = typeof meta?.url === 'string' ? meta.url : null
					fetchedId = typeof meta?.id === 'string' ? meta.id : null
				} catch {
					// ignore: some specifiers may be external/virtual and not fetchable here
				}

				const resolved = await env.pluginContainer.resolveId(specifier, importerHint, { ssr: true })
				const resolvedId = typeof resolved?.id === 'string' ? resolved.id : null

				const hostImportSpecifier = this._bridgeProviders[specifier] ?? specifier

				let exports: unknown
				try {
					exports = await this.importHostExports(hostImportSpecifier)
				} catch (error) {
					logger.warn('failed to bridge host module {specifier}', { specifier, error })
					throw new Error(`[hmr] Failed to bridge host module "${specifier}".`, { cause: error })
				}
				this.bridgedHostExports.set(specifier, exports)

				// Collect all module-id/url variants we want to treat as "already evaluated" in the runner.
				const urls = new Set<string>()
				const addUrl = (u: string | null | undefined) => {
					if (!u) return
					urls.add(u)
					urls.add(cleanUrl(u))
				}

				addUrl(specifier)
				addUrl(resolvedId)
				addUrl(fetchedId)
				addUrl(fetchedUrl)

				const workspaceEntry = await this.resolveWorkspaceEntry(specifier, 'source')
				const candidates = [resolvedId, fetchedId, fetchedUrl, workspaceEntry].filter(
					(v): v is string => typeof v === 'string' && v.length > 0,
				)

				// Normalize candidates through HMR path resolver to get stable absolute paths and
				// their runner/server-root-relative variants (e.g. "/packages/x/src/index.ts").
				for (const c of candidates) {
					const clean = path.toClean(c)
					addUrl(clean)
					for (const v of path.variantsClean ? path.variantsClean(clean) : path.variants(clean))
						addUrl(v)
					if ((clean.startsWith('/') || DRIVE_PATH_RE.test(clean)) && !clean.startsWith('/@'))
						addUrl(pathToFileURL(clean).toString())
				}

				for (const u of urls) this.bridgedRunnerUrls.add(u)

				// Prime a single primary module id so the module-runner won't re-evaluate bridge packages.
				// Prefer a real filesystem path when available.
				const primaryId =
					candidates
						.map((c) => path.toClean(c))
						.find(
							(c) =>
								((c.startsWith('/') && !c.startsWith('/@')) || DRIVE_PATH_RE.test(c)) &&
								existsSync(c),
						) ?? (candidates.length ? path.toClean(candidates[0]!) : specifier)

				this.primeModuleCacheEntry({ id: primaryId, exports, aliases: urls })
			}),
		)
	}

	async assertBridgedSingletons(specifiers: readonly string[]) {
		for (const specifier of specifiers) {
			const host = this.bridgedHostExports.get(specifier)
			if (!host) continue

			const runnerExports = await this.import(specifier)
			if (runnerExports === host) continue

			throw new Error(
				[
					`[HMR] Singleton violation: runner loaded a different instance for "${specifier}".`,
					'This usually means a duplicate workspace copy was evaluated by the runner.',
					'Fix the HMR bridge setup instead of patching core to share global state.',
				].join('\n'),
			)
		}
	}

	private installFetchModuleInterceptor() {
		const transport = (this._runner as unknown as { transport?: unknown })?.transport
		if (!transport || typeof transport !== 'object') return
		const invoke = (transport as Record<string, unknown>).invoke
		if (typeof invoke !== 'function') return

		const originalInvoke = (invoke as (name: string, data: unknown) => Promise<unknown>).bind(
			transport,
		)
		;(transport as Record<string, unknown>).invoke = async (name: string, data: unknown) => {
			if (name === 'fetchModule' && Array.isArray(data)) {
				const url = typeof data[0] === 'string' ? data[0] : null
				if (url) {
					const rawId = unwrapViteId(url)
					const canonicalId = cleanUrl(rawId)
					if (
						this.bridgedRunnerUrls.has(url) ||
						this.bridgedRunnerUrls.has(rawId) ||
						this.bridgedRunnerUrls.has(canonicalId)
					) {
						const cached =
							this.evaluatedModules.getModuleByUrl(url) ??
							this.evaluatedModules.getModuleByUrl(rawId) ??
							this.evaluatedModules.getModuleByUrl(canonicalId)
						if (cached?.promise && cached.meta) return { cache: true }
					}
				}
				const intercepted = await this.tryInterceptFetchModule(data as unknown[])
				if (intercepted) return intercepted
				const result = await originalInvoke(name, data)
				return await this.maybePatchFetchModuleResult(data as unknown[], result)
			}
			return originalInvoke(name, data)
		}
	}

	private async maybePatchFetchModuleResult(_data: unknown[], result: unknown): Promise<unknown> {
		// For "bridge packages", we intentionally prime runner exports to preserve host singleton identity.
		// Vite can mark modules as `invalidate: true` during fetch (even when cached=false), which would
		// wipe our primed `promise/exports` and force re-evaluation (leading to duplicate @pluxel/context).
		if (!result || typeof result !== 'object') return result
		if ('externalize' in (result as Record<string, unknown>)) return result

		const invalidate = (result as Record<string, unknown>).invalidate
		if (invalidate !== true) return result

		const id = (result as Record<string, unknown>).id
		if (typeof id !== 'string') return result

		const rawId = unwrapViteId(id)
		const canonicalId = cleanUrl(rawId)
		if (
			this.bridgedRunnerUrls.has(id) ||
			this.bridgedRunnerUrls.has(rawId) ||
			this.bridgedRunnerUrls.has(canonicalId)
		) {
			;(result as Record<string, unknown>).invalidate = false
			return result
		}

		const fsPath = urlToFsPath(this.env.config.root, id)
		if (!fsPath) return result
		// Be conservative: only patch invalidate when we can confidently map the module to a real file.
		if (!existsSync(fsPath)) return result

		const pkgName = await this.packageNameForFsPath(fsPath)
		if (!pkgName) return result
		if (!isHardBridgeSpecifier(pkgName) && !this.isBridgeModule(pkgName)) return result

		if (process.env.PLUXEL_HMR_DEBUG_FETCH === '1') {
			// eslint-disable-next-line no-console
			console.error('[hmr:runner] patch fetchModule.invalidate=false', { id, pkgName })
		}

		;(result as Record<string, unknown>).invalidate = false
		return result
	}

	private async tryInterceptFetchModule(data: unknown[]): Promise<ExternalizeHint | null> {
		const url = typeof data[0] === 'string' ? data[0] : null
		const importer = typeof data[1] === 'string' ? data[1] : undefined
		if (!url) return null

		const rawId = unwrapViteId(url)
		const canonicalId = cleanUrl(rawId)
		if (
			process.env.PLUXEL_HMR_DEBUG_FETCH === '1' &&
			(canonicalId.includes('/packages/context/') || canonicalId.includes('packages/context/'))
		) {
			// eslint-disable-next-line no-console
			console.error('[hmr:runner] fetchModule', { url, canonicalId, importer })
		}
		if (
			canonicalId.includes('cjs') ||
			canonicalId.includes('@napi-rs') ||
			canonicalId.includes('napi-rs')
		) {
			dbgFetch.debug('fetchModule {rawId}', {
				url,
				rawId: canonicalId,
				importer,
				cjsExternal: this._cjsExternal,
			})
		}

		if (isBarePackageSpecifier(canonicalId)) {
			if (!this.isCjsExternal(canonicalId)) return null
			if (
				canonicalId.includes('cjs') ||
				canonicalId.includes('@napi-rs') ||
				canonicalId.includes('napi-rs')
			) {
				dbgFetch.debug('externalize bare as CJS {rawId}', { rawId: canonicalId })
			}
			return await this.externalizeBareId(canonicalId, importer, { typeHint: 'commonjs' })
		}

		// Some resolvers (tsconfig paths, workspace aliases, export conditions) can turn a bare import into a
		// /@fs/ file URL before the runner sees it. Intercept these as well so:
		// - CJS-only deps are loaded via Node/require.
		const fsPath = urlToFsPath(this.env.config.root, canonicalId)
		if (!fsPath) return null

		if (this._cjsExternal.length === 0) return null
		if (!(await this.isCjsExternalFile(fsPath))) return null
		if (rawId.includes('cjs') || rawId.includes('@napi-rs') || rawId.includes('napi-rs')) {
			dbgFetch.debug('externalize fsPath as CJS {fsPath}', { fsPath })
		}
		return await this.externalizeFsPath(fsPath, { typeHint: 'commonjs' })
	}

	private async externalizeBareId(
		rawId: string,
		importer: string | undefined,
		opts: { typeHint: 'module' | 'commonjs' },
	): Promise<ExternalizeHint | null> {
		const env = this.env
		const options: { skip?: Set<Plugin> } = {}
		if (this._skipPlugin) options.skip = new Set([this._skipPlugin])

		const resolved = await env.pluginContainer.resolveId(rawId, importer, options)
		const fsPath =
			typeof resolved?.id === 'string' ? urlToFsPath(env.config.root, resolved.id) : null
		if (!fsPath) return null

		const canonical = await this.realpathCached(fsPath)

		const ext = canonical.toLowerCase()
		const type =
			ext.endsWith('.cjs') || ext.endsWith('.cts')
				? 'commonjs'
				: opts.typeHint === 'commonjs'
					? 'commonjs'
					: 'module'

		return {
			externalize: pathToFileURL(canonical).toString(),
			type,
		}
	}

	private async externalizeFsPath(
		fsPath: string,
		opts: { typeHint: 'module' | 'commonjs' },
	): Promise<ExternalizeHint> {
		const canonical = await this.realpathCached(fsPath)
		const type = inferModuleTypeFromPath(canonical, opts.typeHint)
		return {
			externalize: pathToFileURL(canonical).toString(),
			type,
		}
	}

	private isCjsExternal(specifier: string) {
		for (const pattern of this._cjsExternal) {
			if (matchesSpecifierPattern(specifier, pattern)) return true
		}
		return false
	}

	private cachedPromise<K, V>(
		map: Map<K, Promise<V>>,
		key: K,
		create: () => Promise<V>,
		opts?: { evictIf?: (value: V) => boolean },
	): Promise<V> {
		return getOrCreatePromise(map, key, create, {
			limit: this._cacheLimit,
			evictIf: opts?.evictIf,
		})
	}

	private async packageNameForFsPath(fsPath: string): Promise<string | null> {
		const canonical = await this.realpathCached(fsPath)
		return await this.cachedPromise(
			this.packageNameByFile,
			canonical,
			() => this.resolvePackageNameForFile(canonical),
			{ evictIf: (name) => !name },
		)
	}

	private async isCjsExternalFile(fsPath: string) {
		const canonical = await this.realpathCached(fsPath)
		const name = await this.cachedPromise(
			this.packageNameByFile,
			canonical,
			() => this.resolvePackageNameForFile(canonical),
			{ evictIf: (resolvedName) => !resolvedName },
		)
		return name ? this.isCjsExternal(name) : false
	}

	private resolvePackageNameForFile(fsPath: string): Promise<string | null> {
		const pkgRoot = findNearestPackageRoot(dirname(fsPath))
		if (!pkgRoot) return Promise.resolve(null)
		return this.cachedPromise(
			this.packageNameByPackageRoot,
			pkgRoot,
			() => this.readPackageName(pkgRoot),
			{ evictIf: (name) => !name },
		)
	}

	private async readPackageName(packageRoot: string): Promise<string | null> {
		try {
			const json = await readFile(`${packageRoot}/package.json`, 'utf8')
			const parsed = JSON.parse(json)
			return typeof parsed?.name === 'string' ? parsed.name : null
		} catch {
			return null
		}
	}

	private isBridgeModule(specifier: string) {
		for (const pattern of this._bridgeModules) {
			if (matchesSpecifierPattern(specifier, pattern)) return true
		}
		return false
	}

	private realpathCached(p: string) {
		return this.cachedPromise(this.realpathCache, p, async () => realpath(p).catch(() => p))
	}

	private resolveWorkspaceEntry(
		specifier: string,
		kind: 'source' | 'dist',
	): Promise<string | null> {
		const key = `${kind}:${specifier}`
		return this.cachedPromise(
			this.workspaceEntryByKey,
			key,
			() => this.resolveWorkspaceEntryImpl(specifier, kind),
			{
				// Avoid caching negative results forever: workspace state can change during dev.
				evictIf: (resolved) => !resolved,
			},
		)
	}

	private async resolveWorkspaceEntryImpl(
		specifier: string,
		kind: 'source' | 'dist',
	): Promise<string | null> {
		const conditions =
			kind === 'source' ? this._workspaceSourceConditions : this._workspaceDistConditions

		try {
			if (kind === 'dist') {
				return resolveModulePath(this._hostResolver, specifier, {
					mode: 'distPreferEsm',
					conditions: ['node', ...conditions],
				})
			}

			return resolveModulePath(this._hostResolver, specifier, { conditions })
		} catch {
			return null
		}
	}

	private async importHostExports(specifier: string): Promise<unknown> {
		try {
			return await import(specifier)
		} catch (error) {
			// Only fall back to workspace resolution when the bare specifier cannot be resolved.
			// If the import throws during evaluation, surfacing the original error is more useful
			// than attempting alternate entrypoints (which can introduce duplicate evaluations).
			const code =
				typeof error === 'object' && error && 'code' in error
					? (error as { code?: unknown }).code
					: undefined
			if (
				code !== 'ERR_MODULE_NOT_FOUND' &&
				code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED' &&
				code !== 'ERR_PACKAGE_IMPORT_NOT_DEFINED' &&
				code !== 'ERR_UNSUPPORTED_DIR_IMPORT'
			) {
				throw error
			}

			const dist = await this.resolveWorkspaceEntry(specifier, 'dist')
			if (!dist) throw new Error(`[hmr] Cannot resolve host export for "${specifier}".`)
			try {
				return await import(pathToFileURL(dist).toString())
			} catch (error) {
				throw new Error(`[hmr] Failed to import host export for "${specifier}" (${dist}).`, {
					cause: error,
				})
			}
		}
	}
}

function setEvaluatedModuleExports(node: EvaluatedModuleNode, exports: unknown) {
	node.exports = exports
	node.evaluated = true
	node.promise = Promise.resolve(exports)
	node.imports.clear()
	node.importers.clear()
}

export function isHardBridgeSpecifier(id: string) {
	if (HARD_BRIDGE_ID_SET.has(id)) return true
	for (const prefix of HARD_BRIDGE_PREFIXES) {
		if (id.startsWith(prefix)) return true
	}
	return false
}

function urlToFsPath(serverRoot: string, idOrUrl: string): string | null {
	if (idOrUrl.startsWith('file://')) {
		try {
			return fileURLToPath(idOrUrl)
		} catch {
			return null
		}
	}
	const asFs = fsPathFromViteFsId(idOrUrl)
	if (asFs) return asFs

	const cleaned = cleanUrl(idOrUrl)
	if (DRIVE_PATH_RE.test(cleaned)) return cleaned
	if (cleaned.startsWith('/@')) return null
	if (!cleaned.startsWith('/')) return null

	// `/abs/path` may be a real filesystem path, but it can also be a Vite URL path (root-relative).
	// Prefer server-root rebasing when it points at a real file (typical Vite root-relative URLs like `/src/*`).
	// Otherwise preserve the original path when it exists on disk.
	const rebased = resolve(serverRoot, cleaned.slice(1))
	if (existsSync(rebased)) return rebased
	if (existsSync(cleaned)) return cleaned
	return rebased
}

function inferModuleTypeFromPath(fsPath: string, hint: 'module' | 'commonjs') {
	const lower = fsPath.toLowerCase()
	if (lower.endsWith('.mjs') || lower.endsWith('.mts')) return 'module'
	if (lower.endsWith('.cjs') || lower.endsWith('.cts')) return 'commonjs'
	return hint
}
