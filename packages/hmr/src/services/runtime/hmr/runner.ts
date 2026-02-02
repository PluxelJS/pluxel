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
	private cjsExternal_: readonly string[] = []
	private skipPlugin_: Plugin | null = null
	private bridgeModules_: readonly string[] = []
	private realpathCache = new Map<string, Promise<string>>()
	private packageNameByPackageRoot = new Map<string, Promise<string | null>>()
	private packageNameByFile = new Map<string, Promise<string | null>>()
	private bridgedHostExports = new Map<string, unknown>()

	init(server: ViteDevServer, opts: HmrRunnerInitOptions = {}) {
		this.env_ = server.environments.ssr
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
		await Promise.all(
			specifiers.map(async (specifier) => {
				if (specifier.endsWith('/*')) return
				try {
					let bareUrl: string | null = null
					try {
						const fetched = await env.fetchModule(specifier)
						bareUrl = typeof fetched?.url === 'string' ? fetched.url : null
					} catch {
						// ignore: some specifiers may be external/virtual and not fetchable here
					}

					const resolved = await env.pluginContainer.resolveId(specifier)
					if (!resolved?.id) return

					const exports = await import(specifier)
					this.bridgedHostExports.set(specifier, exports)

					const urls = new Set<string>()
					urls.add(specifier)
					if (bareUrl) urls.add(bareUrl)
					urls.add(resolved.id)

					const abs = path.toClean(resolved.id)
					urls.add(abs)
					// Only add `/@fs` for real filesystem paths (skip Vite virtual ids like `/@id/*`).
					if (abs.startsWith('/') && !abs.startsWith('/@')) urls.add(`/@fs${abs}`)

					this.primeModuleCacheEntry({ id: resolved.id, exports, aliases: urls })
				} catch (error) {
					logger.warn('failed to bridge host module {specifier}', { specifier, error })
				}
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
				const intercepted = await this.tryInterceptFetchModule(data as unknown[])
				if (intercepted) return intercepted
			}
			return originalInvoke(name, data)
		}
	}

	private async tryInterceptFetchModule(data: unknown[]): Promise<ExternalizeHint | null> {
		const url = typeof data[0] === 'string' ? data[0] : null
		const importer = typeof data[1] === 'string' ? data[1] : undefined
		if (!url) return null

		const rawId = unwrapViteId(url)
		if (rawId.includes('cjs') || rawId.includes('@napi-rs') || rawId.includes('napi-rs')) {
			dbgFetch.debug('fetchModule {rawId}', {
				url,
				rawId,
				importer,
				cjsExternal: this.cjsExternal_,
			})
		}

		if (isBareSpecifier(rawId)) {
			// Bridge core runtime packages: always externalize to the host runtime so singleton identity is preserved.
			if (isHardBridgeSpecifier(rawId) || this.isBridgeModule(rawId)) {
				return await this.externalizeBareId(rawId, importer, { typeHint: 'module' })
			}

			if (!this.isCjsExternal(rawId)) return null
			if (rawId.includes('cjs') || rawId.includes('@napi-rs') || rawId.includes('napi-rs')) {
				dbgFetch.debug('externalize bare as CJS {rawId}', { rawId })
			}
			return await this.externalizeBareId(rawId, importer, { typeHint: 'commonjs' })
		}

		// Some resolvers (tsconfig paths, workspace aliases) can turn a marked bare import into a /@fs/ file URL
		// before the runner sees it. In that case we infer the package name from the file path and apply the
		// user's `cjsExternal` patterns against that name.
		if (this.cjsExternal_.length === 0) return null
		const fsPath = urlToFsPath(this.env.config.root, rawId)
		if (!fsPath) return null
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
	return true
}

function unwrapViteId(url: string) {
	if (url.startsWith('/@id/')) return decodeURIComponent(url.slice('/@id/'.length))
	return url
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
