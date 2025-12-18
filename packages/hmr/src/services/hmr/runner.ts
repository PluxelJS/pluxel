import { createServerModuleRunner, type DevEnvironment, type ViteDevServer } from 'vite'
import { EvaluatedModules, type EvaluatedModuleNode, type ModuleRunner } from 'vite/module-runner'
import type { Plugin } from 'vite'
import { realpath } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import type { HmrPathApi } from './environment'
import { matchesSpecifierPattern } from './internals'

export type PrimeModuleCacheEntryParams = {
	id: string
	exports: any
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

export class HmrRunner {
	public readonly evaluatedModules = new EvaluatedModules()

	private env_: DevEnvironment | null = null
	private runner_: ModuleRunner | null = null
	private cjsExternal_: readonly string[] = []
	private skipPlugin_: Plugin | null = null
	private bridgeModules_: readonly string[] = []
	private realpathCache = new Map<string, Promise<string>>()
	private bridgedHostExports = new Map<string, any>()

	init(server: ViteDevServer, opts: HmrRunnerInitOptions = {}) {
		this.env_ = server.environments.ssr
		this.runner_ = createServerModuleRunner(this.env_, {
			hmr: false,
			evaluatedModules: this.evaluatedModules,
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
		logger: { warn: (obj: any, msg: string) => void },
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
					if (abs.startsWith('/')) urls.add(`/@fs${abs}`)

					this.primeModuleCacheEntry({ id: resolved.id, exports, aliases: urls })
				} catch (error) {
					logger.warn({ specifier, error }, '[HMR] failed to bridge host module')
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
		const runnerAny: any = this.runner_
		const transport = runnerAny?.transport
		if (!transport || typeof transport.invoke !== 'function') return

		const originalInvoke = transport.invoke.bind(transport)
		transport.invoke = async (name: string, data: any) => {
			if (name === 'fetchModule' && Array.isArray(data)) {
				const intercepted = await this.tryInterceptFetchModule(data)
				if (intercepted) return intercepted
			}
			return originalInvoke(name, data)
		}
	}

	private async tryInterceptFetchModule(data: any[]): Promise<any | null> {
		const url = typeof data[0] === 'string' ? data[0] : null
		const importer = typeof data[1] === 'string' ? data[1] : undefined
		if (!url) return null

		const rawId = unwrapViteId(url)
		if (!isBareSpecifier(rawId)) return null

		// Bridge core runtime packages: always externalize to the host runtime so singleton identity is preserved.
		if (isHardBridgeSpecifier(rawId) || this.isBridgeModule(rawId)) {
			return await this.externalizeBareId(rawId, importer, { typeHint: 'module' })
		}

		if (!this.isCjsExternal(rawId)) return null
		return await this.externalizeBareId(rawId, importer, { typeHint: 'commonjs' })
	}

	private async externalizeBareId(
		rawId: string,
		importer: string | undefined,
		opts: { typeHint: 'module' | 'commonjs' },
	): Promise<any | null> {
		const env = this.env
		const options: any = {}
		if (this.skipPlugin_) options.skip = new Set([this.skipPlugin_])

		const resolved = await env.pluginContainer.resolveId(rawId, importer, options)
		const fsPath = resolved?.id ? idToFsPath(resolved.id) : null
		if (!fsPath) return null

		const canonical = await this.realpathCached(fsPath)

		const ext = canonical.toLowerCase()
		const type =
			ext.endsWith('.cjs') || ext.endsWith('.cts') ? 'commonjs' : opts.typeHint === 'commonjs' ? 'commonjs' : 'module'

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

function setEvaluatedModuleExports(node: EvaluatedModuleNode, exports: any) {
	node.exports = exports
	node.evaluated = true
	node.promise = Promise.resolve(exports)
	node.imports.clear()
	node.importers.clear()
}

function isHardBridgeSpecifier(id: string) {
	if (HARD_BRIDGE_IDS.includes(id as any)) return true
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
	if (cleaned.startsWith('/')) return cleaned
	return null
}
