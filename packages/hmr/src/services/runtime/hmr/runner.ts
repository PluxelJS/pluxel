import { existsSync } from 'node:fs'
import { readFile, realpath } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { getDebugLogger } from '@pluxel/core/logger'
import { createResolver } from 'exsolve'
import { dirname, resolve } from 'pathe'
import type { Plugin } from 'vite'
import { createServerModuleRunner, type DevEnvironment, type ViteDevServer } from 'vite'
import {
	ESModulesEvaluator,
	type EvaluatedModuleNode,
	EvaluatedModules,
	type ModuleRunner,
} from 'vite/module-runner'
import type { HmrPathApi } from './environment'
import { findNearestPackageRoot, matchesSpecifierPattern } from './internals'

export type PrimeModuleCacheEntryParams = {
	id: string
	exports: unknown
	aliases?: Iterable<string>
}

export type HmrRunnerInitOptions = {
	/** CJS-only specifiers/prefixes that must be executed via Node/require. */
	cjsExternal?: readonly string[]
	/** The Vite plugin that owns HMR resolveId hooks, skipped when resolving CJS externals to real files. */
	skipPlugin?: Plugin
	/** Modules that must be shared as host singletons (loaded by host and runner). */
	bridgeModules?: readonly string[]
}

const HARD_BRIDGE_IDS = ['@pluxel/core', '@pluxel/hmr', '@pluxel/context'] as const
const HARD_BRIDGE_PREFIXES = ['@pluxel/core/', '@pluxel/hmr/', '@pluxel/context/'] as const
const HARD_BRIDGE_ID_SET = new Set<string>(HARD_BRIDGE_IDS)
const dbgFetch = getDebugLogger('pluxel:hmr:fetch').with({ name: 'runner' })

type ExternalizeHint = {
	externalize: string
	type: 'module' | 'commonjs'
}

export class HmrRunner {
	public readonly evaluatedModules = new EvaluatedModules()

	private env_: DevEnvironment | null = null
	private runner_: ModuleRunner | null = null
	private workspaceRoot_ = ''
	private resolver_!: ReturnType<typeof createResolver>
	private cjsExternal_: readonly string[] = []
	private skipPlugin_: Plugin | null = null
	private bridgeModules_: readonly string[] = []
	private realpathCache = new Map<string, Promise<string>>()
	private packageNameByPackageRoot = new Map<string, Promise<string | null>>()
	private packageNameByFile = new Map<string, Promise<string | null>>()
	private bridgedHostExports = new Map<string, unknown>()
	private bridgedRunnerUrls = new Set<string>()
	private workspaceExportEntryBySpecifier = new Map<string, Promise<string | null>>()
	private workspaceDistEntryBySpecifier = new Map<string, Promise<string | null>>()

	init(server: ViteDevServer, opts: HmrRunnerInitOptions = {}) {
		this.env_ = server.environments.ssr
		this.workspaceRoot_ = server.config.root
		// Use the workspace root as the resolution base for package.json/export lookups.
		// (This avoids relying on `node:module` / createRequire in ESM.)
		const fromDirUrl = pathToFileURL(`${resolve(this.workspaceRoot_)}/`).toString()
		this.resolver_ = createResolver({ from: fromDirUrl, cache: new Map() })
		const hasNativeSourcemapSupport =
			typeof (globalThis as unknown as { process?: { setSourceMapsEnabled?: unknown } })?.process
				?.setSourceMapsEnabled === 'function'
		this.runner_ = createServerModuleRunner(this.env_, {
			hmr: false,
			evaluatedModules: this.evaluatedModules,
			// Prefer Node/Bun native sourcemap support when available; fall back to Vite's
			// prepareStackTrace interceptor (older runtimes / edge environments).
			sourcemapInterceptor: hasNativeSourcemapSupport ? 'node' : 'prepareStackTrace',
			// Ensure stack traces are aligned when running modules via AsyncFunction wrapper.
			// (ESModulesEvaluator applies the appropriate `startOffset` for inlined sourcemaps.)
			evaluator: new ESModulesEvaluator(),
		})

		this.cjsExternal_ = opts.cjsExternal ?? []
		this.skipPlugin_ = opts.skipPlugin ?? null
		this.bridgeModules_ = opts.bridgeModules ?? []
		this.installFetchModuleInterceptor()
	}

	get env(): DevEnvironment {
		if (!this.env_) throw new Error('HmrRunner not initialized')
		return this.env_
	}

	get runner(): ModuleRunner {
		if (!this.runner_) throw new Error('HmrRunner not initialized')
		return this.runner_
	}

	import(id: string) {
		return this.runner.import(id)
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

	async bridgeHostModules(
		specifiers: readonly string[],
		path: HmrPathApi,
		logger: { warn: (message: string, props?: Record<string, unknown>) => void },
	) {
		const env = this.env
		const importerHint = (() => {
			const p = resolve(env.config.root, 'package.json')
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
					fetchedUrl =
						typeof (fetched as { url?: unknown } | null)?.url === 'string' ? fetched.url : null
					fetchedId =
						typeof (fetched as { id?: unknown } | null)?.id === 'string' ? fetched.id : null
				} catch {
					// ignore: some specifiers may be external/virtual and not fetchable here
				}

				const resolved = await env.pluginContainer.resolveId(specifier, importerHint, { ssr: true })
				const resolvedId = typeof resolved?.id === 'string' ? resolved.id : null

				let exports: unknown
				try {
					exports = await this.importHostExports(specifier)
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

				const workspaceEntry = await this.resolveWorkspaceExportEntry(specifier)
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
					if (clean.startsWith('/') && !clean.startsWith('/@'))
						addUrl(pathToFileURL(clean).toString())
				}

				for (const u of urls) this.bridgedRunnerUrls.add(u)

				// Prime a single primary module id so the module-runner won't re-evaluate bridge packages.
				// Prefer a real filesystem path when available.
				const primaryId =
					candidates
						.map((c) => path.toClean(c))
						.find((c) => c.startsWith('/') && !c.startsWith('/@') && existsSync(c)) ??
					(candidates.length ? path.toClean(candidates[0]!) : specifier)

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
		const transport = (this.runner_ as unknown as { transport?: unknown })?.transport
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

		const fsPath = urlToFsPath(this.env.config.root, id)
		if (!fsPath) return result

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
				cjsExternal: this.cjsExternal_,
			})
		}

		if (isBareSpecifier(canonicalId)) {
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

		if (this.cjsExternal_.length === 0) return null
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
		if (this.skipPlugin_) options.skip = new Set([this.skipPlugin_])

		const resolved = await env.pluginContainer.resolveId(rawId, importer, options)
		const fsPath = resolved?.id ? idToFsPath(resolved.id) : null
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
		for (const pattern of this.cjsExternal_) {
			if (matchesSpecifierPattern(specifier, pattern)) return true
		}
		return false
	}

	private async packageNameForFsPath(fsPath: string): Promise<string | null> {
		const canonical = await this.realpathCached(fsPath)
		const cached = this.packageNameByFile.get(canonical)
		if (cached) return await cached
		const promise = this.resolvePackageNameForFile(canonical)
		this.packageNameByFile.set(canonical, promise)
		return await promise
	}

	private async isCjsExternalFile(fsPath: string) {
		const canonical = await this.realpathCached(fsPath)
		const cached = this.packageNameByFile.get(canonical)
		if (cached) {
			const name = await cached
			return name ? this.isCjsExternal(name) : false
		}
		const promise = this.resolvePackageNameForFile(canonical)
		this.packageNameByFile.set(canonical, promise)
		const name = await promise
		return name ? this.isCjsExternal(name) : false
	}

	private resolvePackageNameForFile(fsPath: string): Promise<string | null> {
		const pkgRoot = findNearestPackageRoot(dirname(fsPath))
		if (!pkgRoot) return Promise.resolve(null)
		const cached = this.packageNameByPackageRoot.get(pkgRoot)
		if (cached) return cached
		const promise = this.readPackageName(pkgRoot)
		this.packageNameByPackageRoot.set(pkgRoot, promise)
		return promise
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
		for (const pattern of this.bridgeModules_) {
			if (matchesSpecifierPattern(specifier, pattern)) return true
		}
		return false
	}

	private realpathCached(p: string) {
		const cached = this.realpathCache.get(p)
		if (cached) return cached
		const promise = realpath(p).catch(() => p)
		this.realpathCache.set(p, promise)
		return promise
	}

	private resolveWorkspaceExportEntry(specifier: string): Promise<string | null> {
		const cached = this.workspaceExportEntryBySpecifier.get(specifier)
		if (cached) return cached
		const promise = this.resolveWorkspaceExportEntryImpl(specifier)
		this.workspaceExportEntryBySpecifier.set(specifier, promise)
		return promise
	}

	private async resolveWorkspaceExportEntryImpl(specifier: string): Promise<string | null> {
		return await this.resolveWorkspaceExportImpl(specifier, [
			'@pluxel/hmr',
			'@pluxel/source',
			'import',
			'default',
		])
	}

	private resolveWorkspaceDistEntry(specifier: string): Promise<string | null> {
		const cached = this.workspaceDistEntryBySpecifier.get(specifier)
		if (cached) return cached
		const promise = this.resolveWorkspaceDistEntryImpl(specifier)
		this.workspaceDistEntryBySpecifier.set(specifier, promise)
		return promise
	}

	private async resolveWorkspaceDistEntryImpl(specifier: string): Promise<string | null> {
		return await this.resolveWorkspaceExportImpl(specifier, ['import', 'default', 'require'])
	}

	private async resolveWorkspaceExportImpl(
		specifier: string,
		conditions: readonly string[],
	): Promise<string | null> {
		const parsed = splitPackageSpecifier(specifier)
		if (!parsed) return null
		const { pkgName, exportKey } = parsed
		try {
			const pkgJsonPath =
				this.resolver_.resolveModulePath(`${pkgName}/package.json`, { try: true }) ??
				this.tryResolveWorkspacePackageJson(pkgName)
			if (!pkgJsonPath) return null
			const pkgRoot = dirname(pkgJsonPath)
			const json = await readFile(pkgJsonPath, 'utf8')
			const pkg = JSON.parse(json) as { exports?: unknown }
			const exportsField = pkg.exports
			const entry = resolveExportTarget(exportsField, exportKey)
			if (!entry) return null
			const picked = pickConditionalExport(entry, conditions)
			if (!picked) return null
			if (picked.startsWith('./')) return resolve(pkgRoot, picked)
			if (picked.startsWith('../') || picked.startsWith('/')) return resolve(pkgRoot, picked)
			// Unhandled (non-path) export targets (e.g. "node:" or "http:") are ignored.
			return null
		} catch {
			return null
		}
	}

	private tryResolveWorkspacePackageJson(pkgName: string): string | null {
		if (!this.workspaceRoot_) return null
		const short = pkgName.startsWith('@') ? pkgName.split('/')[1] : pkgName
		if (!short) return null
		const candidates = [
			resolve(this.workspaceRoot_, 'packages', short, 'package.json'),
			resolve(this.workspaceRoot_, 'packages', 'plugins', short, 'package.json'),
		]
		for (const p of candidates) {
			if (existsSync(p)) return p
		}
		return null
	}

	private async importHostExports(specifier: string): Promise<unknown> {
		try {
			return await import(specifier)
		} catch {
			const dist = await this.resolveWorkspaceDistEntry(specifier)
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

function isBareSpecifier(id: string | undefined) {
	if (!id) return false
	if (id.startsWith('.') || id.startsWith('/') || id.startsWith('\0')) return false
	// Schemed ids are not bare package specifiers.
	// (We still handle `node:` builtins elsewhere via Vite's own logic.)
	if (id.startsWith('file:')) return false
	return true
}

function unwrapViteId(url: string) {
	if (url.startsWith('/@id/')) return decodeURIComponent(url.slice('/@id/'.length))
	return url
}

function splitPackageSpecifier(specifier: string): { pkgName: string; exportKey: string } | null {
	if (!specifier) return null
	if (specifier.startsWith('@')) {
		const parts = specifier.split('/')
		if (parts.length < 2) return null
		const pkgName = `${parts[0]}/${parts[1]}`
		if (parts.length === 2) return { pkgName, exportKey: '.' }
		return { pkgName, exportKey: `./${parts.slice(2).join('/')}` }
	}
	const parts = specifier.split('/')
	const pkgName = parts[0]!
	if (parts.length === 1) return { pkgName, exportKey: '.' }
	return { pkgName, exportKey: `./${parts.slice(1).join('/')}` }
}

function resolveExportTarget(exportsField: unknown, exportKey: string): unknown {
	if (!exportsField) return null
	if (typeof exportsField === 'string') return exportKey === '.' ? exportsField : null
	if (typeof exportsField !== 'object') return null
	const exp = exportsField as Record<string, unknown>
	// Some packages use "exports": { ".": {...}, "./sub": {...} }
	if (exportKey in exp) return exp[exportKey]
	// Some packages use "exports": { "@pluxel/source": "...", "default": "..." } (root only)
	if (exportKey === '.') return exp
	return null
}

function pickConditionalExport(target: unknown, conditions: readonly string[]): string | null {
	if (!target) return null
	if (typeof target === 'string') return target
	if (typeof target !== 'object') return null
	const obj = target as Record<string, unknown>
	for (const c of conditions) {
		if (c in obj) return pickConditionalExport(obj[c], conditions)
	}
	if ('default' in obj) return pickConditionalExport(obj.default, conditions)
	return null
}

function cleanUrl(id: string) {
	const i = id.indexOf('?')
	return i >= 0 ? id.slice(0, i) : id
}

function idToFsPath(id: string): string | null {
	const cleaned = cleanUrl(id)
	if (cleaned.startsWith('/@fs/')) return cleaned.slice('/@fs'.length)
	return null
}

function urlToFsPath(serverRoot: string, idOrUrl: string): string | null {
	if (idOrUrl.startsWith('file://')) {
		try {
			return fileURLToPath(idOrUrl)
		} catch {
			return null
		}
	}
	const asFs = idToFsPath(idOrUrl)
	if (asFs) return asFs

	const cleaned = cleanUrl(idOrUrl)
	if (!cleaned.startsWith('/')) return null

	// `/abs/path` may be a real filesystem path, but it can also be a Vite URL path (root-relative).
	// Prefer real paths when they exist; otherwise resolve against the server root.
	if (existsSync(cleaned)) return cleaned
	return resolve(serverRoot, cleaned.slice(1))
}

function inferModuleTypeFromPath(fsPath: string, hint: 'module' | 'commonjs') {
	const lower = fsPath.toLowerCase()
	if (lower.endsWith('.mjs') || lower.endsWith('.mts')) return 'module'
	if (lower.endsWith('.cjs') || lower.endsWith('.cts')) return 'commonjs'
	return hint
}
