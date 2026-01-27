import { fileURLToPath } from 'node:url'
import type { Logger as LogtapeLogger } from '@logtape/logtape'
import { type Context, Injectable } from '@pluxel/core'
import { getDebugLogger } from '@pluxel/core/logger'
import { dirname, resolve } from 'pathe'
import {
	createServer,
	type DevEnvironment,
	normalizePath,
	type Plugin,
	type ViteDevServer,
} from 'vite'
import type { BuiltinPluginSpec } from '../loader/LoaderService'
import { AsyncSerialLock } from './async-serial-lock'
import {
	buildHmrViteConfig,
	type HMRDependencyConfig,
	type ResolvedHMRDependencyConfig,
	resolveFsAllowList,
	resolveHMRDependencyConfig,
} from './config'
import { HmrEnvironment, type HmrPathApi, type HmrToolkit } from './environment'
import { resolveGlobPatterns } from './globs'
import {
	BatchDebouncer,
	findNearestPackageRoot,
	matchesSpecifierPattern,
	startTimer,
} from './internals'
import { logAttributionReport, TimingTracker } from './logging'
import { collectColdStartEntries, HmrBatchProcessor, HmrExecutor } from './pipeline'
import { HmrRunner, isHardBridgeSpecifier } from './runner'
import { installRequireShims, type RuntimeShimConfig, RuntimeShimRegistry } from './runtime-shims'

export interface HMRConfig {
	/** 业务扫描边界：默认仅这些目录下的 `.ts` 会被纳入 HMR 入口挑选（`.tsx`/`.jsx` 默认排除） */
	roots: string[]
	/**
	 * 额外的 HMR include glob（优先级高于默认的 `roots/**` + `.ts`）。
	 * - 需要完整路径或相对 cwd 的 glob
	 * - 适用于强制隔离“插件 HMR”与“前端 HMR”
	 */
	include?: string[]
	/**
	 * 额外的 HMR exclude glob（默认已排除 `node_modules`/`.d.ts`）。
	 * - 需要完整路径或相对 cwd 的 glob
	 */
	exclude?: string[]
	/** 额外允许 Vite Dev Server 访问的目录（绝对路径或会基于 cwd 解析的相对路径） */
	fsAllow?: string[]
	/** 依赖相关配置（external / bridge / optimizeDeps 等） */
	deps?: HMRDependencyConfig
	/**
	 * 额外的 Vite 插件（仅用于 HMR dev server）。
	 *
	 * 用途示例：
	 * - 下游自己加宏：`import Macros from 'unplugin-macros/vite'; vitePlugins: [Macros()]`
	 */
	vitePlugins?: Plugin[]
	/**
	 * Preloaded plugin constructors that should be enabled without needing a scanned entry file.
	 *
	 * Supported forms are the same as `LoaderService.preloadPlugins()`:
	 * - plugin ctor
	 * - `{ plugin, forks }` for forkable builtins
	 */
	builtins?: readonly BuiltinPluginSpec[]
}

const BATCH_DEBOUNCE_MS = 30
const BATCH_MAX_WAIT_MS = 120
const BATCH_MAX_FILES = 2000

const hmrPackageRoot = (() => {
	try {
		return findNearestPackageRoot(dirname(fileURLToPath(import.meta.url)))
	} catch {
		return null
	}
})()

const serviceName = 'hmrService' as const
const HMR_EXPORT_CONDITIONS = ['@pluxel/hmr', 'import', 'module', 'default'] as const

declare module '@pluxel/core' {
	namespace Context {
		interface Services {
			[serviceName]: HMRService
		}
		interface Config {
			[serviceName]: HMRConfig
		}
	}
}

const unique = <T>(iter: Iterable<T>) => Array.from(new Set(iter))

const WORKSPACE_ENTRY_CACHE_LIMIT = 2000

@Injectable({ key: serviceName, scope: 'root' })
export class HMRService {
	public vite!: ViteDevServer
	private startPromise?: Promise<void>
	private serverConfiguredResolve?: () => void
	private serverConfiguredReject?: (error: unknown) => void
	private readonly serverConfigured: Promise<void>

	private ssrEnv!: DevEnvironment
	private readonly runner = new HmrRunner()
	private executor!: HmrExecutor
	private batchProcessor!: HmrBatchProcessor

	private readonly cwd = process.cwd()
	private readonly scanRootsAbs: string[]
	private readonly env: HmrEnvironment
	public readonly toolkit: HmrToolkit
	public readonly path: HmrPathApi
	private readonly includeGlobs?: string[]
	private readonly excludeGlobs?: string[]

	private readonly deps: ResolvedHMRDependencyConfig
	private readonly runtimeShims: RuntimeShimRegistry
	private readonly useRequireShims: boolean

	private readonly timing: TimingTracker

	private readonly workspaceEntryResolveCache = new Map<
		string,
		Map<string, Promise<string | null>>
	>()
	private workspaceEntryResolveCacheSize = 0
	private didPreloadBuiltins = false
	private baseline?: Promise<void>
	private readonly execLock = new AsyncSerialLock()
	private warmupStarted = false

	private debouncer!: BatchDebouncer

	private readonly dbg: {
		modules: LogtapeLogger
		warmup: LogtapeLogger
		batch: LogtapeLogger
		cache: LogtapeLogger
		graph: LogtapeLogger
		timeEntry: LogtapeLogger
	}

	private readonly plugin: Plugin
	private readonly workspaceConditions = [...HMR_EXPORT_CONDITIONS]

	constructor(
		public ctx: Context,
		private readonly config: HMRConfig,
	) {
		this.serverConfigured = new Promise<void>((resolve, reject) => {
			this.serverConfiguredResolve = resolve
			this.serverConfiguredReject = reject
		})

		this.scanRootsAbs = unique(
			this.config.roots.map((dir) => normalizePath(resolve(this.cwd, dir))),
		)
		this.includeGlobs = resolveGlobPatterns(this.config.include, this.cwd)
		this.excludeGlobs = resolveGlobPatterns(this.config.exclude, this.cwd)
		this.env = new HmrEnvironment(this.ctx, {
			cwd: this.cwd,
			scanRootsAbs: this.scanRootsAbs,
			workspaceConditions: this.workspaceConditions,
			includeGlobs: this.includeGlobs,
			excludeGlobs: this.excludeGlobs,
		})
		this.toolkit = this.env.toolkit
		this.path = this.toolkit.path

		this.deps = resolveHMRDependencyConfig(this.config.deps)

		// For correctness and consistency, always isolate reflect-metadata from the host runtime.
		// This keeps decorator metadata behavior deterministic and avoids polluting global Reflect.
		const runtimeResolved = { shimReflectMetadata: true, shims: {} } satisfies {
			shimReflectMetadata: boolean
			shims: Record<string, RuntimeShimConfig>
		}
		this.runtimeShims = new RuntimeShimRegistry(runtimeResolved)
		this.useRequireShims = true
		if (this.useRequireShims) installRequireShims((id) => this.runtimeShims.require(id))

		const getDebugChannel = (topic: string): LogtapeLogger => {
			const logger = (this.ctx as unknown as { logger?: unknown }).logger
			const fn =
				logger && typeof logger === 'object'
					? (logger as Record<string, unknown>).getDebugChannel
					: undefined
			if (typeof fn === 'function') {
				return (fn as (t: string) => LogtapeLogger).call(logger, topic)
			}
			// Fallback for tests / mocked contexts: use the global debug channel logger.
			return getDebugLogger(topic).with({ name: 'hmr', context: this.ctx?.name ?? 'hmr' })
		}

		this.dbg = {
			modules: getDebugChannel('pluxel:hmr:modules'),
			warmup: getDebugChannel('pluxel:hmr:warmup'),
			batch: getDebugChannel('pluxel:hmr:batch'),
			cache: getDebugChannel('pluxel:hmr:cache'),
			graph: getDebugChannel('pluxel:hmr:graph'),
			timeEntry: getDebugChannel('pluxel:hmr:time:entry'),
		}

		this.timing = new TimingTracker({
			formatId: (id) => this.path.pretty(id),
			debugEntry: this.dbg.timeEntry,
		})

		this.plugin = this.createRunnerPlugin()
	}

	public normalizeId(id: string): string {
		return this.path.toClean(id)
	}

	public moduleIdAliases(id: string): string[] {
		return this.path.variants(id)
	}

	public setServerRoot(root: string) {
		this.env.setServerRoot(root)
	}

	public primeModuleCacheEntry(params: {
		id: string
		exports: unknown
		aliases?: Iterable<string>
	}) {
		this.runner.primeModuleCacheEntry(params)
	}

	public dropModuleCacheEntries(ids: Iterable<string>) {
		this.runner.dropModuleCacheEntries(ids)
	}

	/**
	 * Execute and (optionally) inject plugin modules, using the same pipeline as HMR updates.
	 *
	 * This is intentionally a thin wrapper around the internal executor so tests and tooling can
	 * trigger evaluation without reaching into private fields.
	 */
	public async executeFiles(filesPath: readonly string[], keepOrder = true): Promise<void> {
		if (!this.executor) {
			throw new Error('HMRService not initialized (Vite server not configured yet)')
		}
		await this.ensureBaseline()
		await this.execLock.run(async () => {
			await this.executor.runAndLoadAll(filesPath, keepOrder)
		})
	}

	public start(): Promise<void> {
		if (this.startPromise) return this.startPromise
		const p = this.startImpl()
		this.startPromise = p.catch((error) => {
			this.startPromise = undefined
			throw error
		})
		return this.startPromise
	}

	private async startImpl(): Promise<void> {
		const serverFsAllow = resolveFsAllowList({
			cwd: this.cwd,
			cwdNormalized: this.env.paths.cwdNormalizedPath,
			scanRoots: this.scanRootsAbs,
			configFsAllow: Array.isArray(this.config.fsAllow) ? this.config.fsAllow : undefined,
			hmrPackageRoot,
		})
		const serverConfig = buildHmrViteConfig({
			// Vite root should point at the HMR package UI, not the host cwd.
			// Otherwise dep optimization may not crawl the correct entries and will try to update deps at runtime.
			root: hmrPackageRoot ?? this.cwd,
			fsAllow: serverFsAllow,
			scanRoots: this.config.roots,
			deps: this.deps,
			extraPlugins: this.config.vitePlugins,
			runnerPlugin: this.plugin,
			honoPlugin: this.ctx.honoService.viteHonoDevServer,
			includeGlobs: this.includeGlobs,
			excludeGlobs: this.excludeGlobs,
		})
		const server = await createServer(serverConfig)
		try {
			// Parallelize "listen" (Vite server boot) and "baseline" (bridge + builtins),
			// so overall startup latency is closer to the slower of the two.
			await Promise.all([
				server.listen(),
				// Fail-fast on core HMR correctness errors (bridge/builtins baseline). If this throws,
				// the host process should crash rather than limping along with a broken HMR runtime.
				this.ensureBaseline(),
			])

			// Warmup is opt-in: keep default startup as fast and quiet as possible.
			const warmupFlag = process.env.PLUXEL_HMR_WARMUP
			if (warmupFlag === '1' || warmupFlag === 'true') this.startWarmup()
		} catch (error) {
			await server.close().catch(() => undefined)
			throw error
		}

		server.printUrls()
		this.ctx.logger.info`HMR 服务已启动，只监听：${this.config.roots.join(', ')}`
	}

	private createRunnerPlugin(): Plugin {
		const plugin: Plugin = {
			name: 'pluxel-runner',
			enforce: 'pre',
			apply: 'serve',

			configureServer: async (server) => this.configureServer(server),

			resolveId: async (id, importer, options) => {
				// Hard isolation: runner-only resolution must never affect the client environment
				// (the dev server also serves a browser UI + extension compilation).
				if (!options?.ssr) return null

				const shimResolved = this.runtimeShims.resolveId(id)
				if (shimResolved) return shimResolved

				if (this.ctx.scanService) {
					// Never let workspace resolution rewrite bridged singleton modules, otherwise we may end up
					// evaluating a second copy (e.g. workspace TS sources) in the runner.
					if (this.isHardBridgeModule(id) || this.isBridgeModule(id)) {
						return null
					}

					const resolved = await this.resolveBareWorkspaceEntry(id, importer ?? null)
					if (resolved) return { id: resolved }
				}
				return null
			},

			load: (id, options) => {
				if (!options?.ssr) return null
				return this.runtimeShims.load(id) ?? null
			},
		}
		return plugin
	}

	private async configureServer(server: ViteDevServer): Promise<void> {
		this.vite = server
		this.setServerRoot(server.config.root)

		try {
			this.configureRunner(server)
			this.configurePipeline()
			this.setupBatching()
			this.registerWatchers(server)
			this.serverConfiguredResolve?.()
		} catch (error) {
			this.serverConfiguredReject?.(error)
			throw error
		} finally {
			this.serverConfiguredResolve = undefined
			this.serverConfiguredReject = undefined
		}
	}

	private configureRunner(server: ViteDevServer) {
		this.runner.init(server, {
			cjsExternal: this.deps.cjsExternal,
			bridgeModules: this.deps.bridgeModules,
			skipPlugin: this.plugin,
		})
		this.ssrEnv = this.runner.env
	}

	private async bridgeHostModules() {
		const logger = this.ctx.logger as unknown as {
			warn?: (message: string, props?: Record<string, unknown>) => void
		}
		await this.runner.bridgeHostModules(this.deps.bridgeModules, this.path, {
			warn: (message, props) => logger.warn?.(message, props),
		})
		await this.runner.assertBridgedSingletons(this.deps.bridgeModules)
	}

	private configurePipeline() {
		this.executor = new HmrExecutor(this.ctx, this.runner, this.path, this.timing, {
			dbgModules: this.dbg.modules,
			useRequireShims: this.useRequireShims,
		})

		this.batchProcessor = new HmrBatchProcessor(
			this.ctx,
			this.ssrEnv,
			this.runner,
			this.executor,
			this.path,
			this.toolkit,
			this.timing,
			{
				// Keep runtime evaluation fast and quiet by default:
				// - No transform-prefetching (attribution off)
				// - No big per-batch attribution reports
				attribution: 'off',
				prefetchLimit: 0,
				prefetchOrder: 'near',
				prefetchConcurrency: 0,
			},
			{
				batch: this.dbg.batch,
				cache: this.dbg.cache,
				graph: this.dbg.graph,
			},
			() => this.getAnchorsCleanSnapshot(),
		)
	}

	private ensureBaseline(): Promise<void> {
		if (this.baseline) return this.baseline
		this.baseline = this.serverConfigured
			.then(() => this.bootstrapBaseline())
			.catch((error) => {
				// Allow retries if baseline fails (bridge/builtins can fail during dev).
				this.baseline = undefined
				this.didPreloadBuiltins = false
				throw error
			})
		return this.baseline
	}

	private async bootstrapBaseline(): Promise<void> {
		// 1) Bridge host modules (singleton identity).
		await this.bridgeHostModules()

		// 2) Establish builtin baseline (so later batch rollbacks fall back to it).
		await this.preloadBuiltins()
	}

	private startWarmup() {
		if (this.warmupStarted) return
		this.warmupStarted = true
		// Warmup is best-effort: it must never prevent the host from running once baseline is correct.
		void this.performWarmup().catch((error) => {
			this.ctx.logger.error('warmup failed', { error })
		})
	}

	private async preloadBuiltins(): Promise<void> {
		if (this.didPreloadBuiltins) return
		this.didPreloadBuiltins = true

		const builtins = this.config.builtins
		if (!builtins?.length) return

		const config = this.ctx.configService
		if (!config.isReady) await config.ready

		try {
			const resolved = [...builtins]
			// Commit builtins as a baseline so later loader batch rollbacks revert back to a container
			// that already includes the built-in plugins.
			await this.ctx.loader.preloadPlugins(resolved, { commit: true })
		} catch (error) {
			// Allow a retry on the next start cycle (or in tests) when configuration changes.
			this.didPreloadBuiltins = false
			throw error
		}
	}

	private setupBatching() {
		this.debouncer = new BatchDebouncer(
			async (files, epoch) => {
				await this.ensureBaseline()
				return await this.execLock.run(() => this.batchProcessor.process(files, epoch))
			},
			BATCH_DEBOUNCE_MS,
			BATCH_MAX_WAIT_MS,
			BATCH_MAX_FILES,
			(error) => this.ctx.logger.error('batch flush failed', { error }),
		)
	}

	private registerWatchers(server: ViteDevServer) {
		server.watcher.on('change', (file) => this.enqueueFileChange(file))
		server.watcher.on('add', (file) => this.enqueueFileChange(file))
		server.watcher.on('unlink', (file) => this.enqueueFileChange(file))
	}

	private enqueueFileChange(file: string) {
		const clean = this.path.toClean(file)
		if (this.toolkit.pathFilter(clean)) {
			this.debouncer.push(clean)
			return true
		}
		if (!this.isAnchorClean(clean)) return false
		this.debouncer.push(clean)
		return true
	}

	private isAnchorClean(clean: string): boolean {
		for (const a of this.ctx.loader.api.anchors.list()) {
			const id = this.path.toClean(a)
			if (id.startsWith('\0')) continue
			if (id.includes('/node_modules/')) continue
			if (id === clean) return true
		}
		return false
	}

	private async performWarmup() {
		await this.execLock.run(async () => {
			const endAll = startTimer()
			const endScan = startTimer()
			const anchors = this.getAnchorsCleanSnapshot()
			const entries = await collectColdStartEntries({
				rootsAbs: this.scanRootsAbs,
				anchors,
				path: this.path,
				scanService: this.ctx.scanService,
				workspaceConditions: this.workspaceConditions,
			})
			const scanMs = Math.round(endScan() * 10) / 10
			const coldFiles = unique(entries.map((p) => this.path.toClean(p)))
				.filter((id) => anchors.has(id) || this.toolkit.pathFilter(id))
				.sort()
			const dbgWarmup = this.dbg.warmup
			dbgWarmup.debug((l) => l`scan: ${coldFiles.length} files in ${scanMs}ms`)

			const endWarmup = startTimer()

			const prettyFiles = coldFiles.map((f) => this.path.pretty(f))
			dbgWarmup.debug(
				(l) => l`files (${prettyFiles.length})\n${prettyFiles.map((f) => `    ${f}`).join('\n')}`,
			)

			const executed = await this.executor.runAndLoadAll(coldFiles, true)
			const commitMs = executed ? Math.round(executed.commitMs * 10) / 10 : null

			const warmupMs = Math.round(endWarmup() * 10) / 10
			const totalMs = Math.round(endAll() * 10) / 10
			this.ctx.logger.info('HMR warmup done', {
				files: coldFiles.length,
				scanMs,
				warmupMs,
				commitMs,
				totalMs,
			})

			// Full attribution output is debug-only (opt-in for profiling).
			if (process.env.PLUXEL_HMR_ATTRIBUTION === '1') {
				logAttributionReport(
					this.ctx.logger,
					{
						changed: coldFiles[0] ?? 'N/A',
						targets: coldFiles,
						timing: this.timing,
						prettyId: (id) => this.path.pretty(id),
					},
					{ level: 'debug' },
				)
			}
		})
	}

	private resolveBareWorkspaceEntry(specifier: string, importer: string | null) {
		// Fast-path: only bare specifiers can be rewritten to workspace entries.
		// Avoid allocating cache entries for relative, absolute, or virtual ids.
		if (
			!specifier ||
			specifier.startsWith('.') ||
			specifier.startsWith('/') ||
			specifier.startsWith('\0') ||
			// Windows absolute paths.
			/^[a-zA-Z]:[\\/]/.test(specifier) ||
			// Schemed ids: node:, file:, data:, virtual:, etc.
			specifier.includes(':')
		) {
			return Promise.resolve(null)
		}

		const importerKey = importer ? this.path.toClean(importer) : ''
		let byImporter = this.workspaceEntryResolveCache.get(specifier)
		if (byImporter) {
			// LRU-ish: keep hot specifiers near the end so eviction stays cheap.
			this.workspaceEntryResolveCache.delete(specifier)
			this.workspaceEntryResolveCache.set(specifier, byImporter)
		} else {
			byImporter = new Map()
			this.workspaceEntryResolveCache.set(specifier, byImporter)
		}

		const cached = byImporter.get(importerKey)
		if (cached) return cached

		const p = this.env
			.resolveBareWorkspaceModule(specifier, importerKey || null)
			.catch(() => null)
			.then((resolved) => {
				// Avoid caching negative results forever: workspace state can change during dev.
				if (!resolved) {
					const cur = this.workspaceEntryResolveCache.get(specifier)
					if (cur?.delete(importerKey)) this.workspaceEntryResolveCacheSize--
					if (cur?.size === 0) this.workspaceEntryResolveCache.delete(specifier)
				}
				return resolved
			})

		byImporter.set(importerKey, p)
		this.workspaceEntryResolveCacheSize++

		// Best-effort eviction to avoid unbounded growth under a large, churny dependency graph.
		// Evict by specifier (LRU order), which is cheap and keeps hot deps stable.
		if (this.workspaceEntryResolveCacheSize > WORKSPACE_ENTRY_CACHE_LIMIT) {
			const targetSize = Math.floor(WORKSPACE_ENTRY_CACHE_LIMIT * 0.8)
			for (const [spec, map] of this.workspaceEntryResolveCache) {
				this.workspaceEntryResolveCache.delete(spec)
				this.workspaceEntryResolveCacheSize -= map.size
				if (this.workspaceEntryResolveCacheSize <= targetSize) break
			}
		}

		return p
	}

	private getAnchorsCleanSnapshot(): ReadonlySet<string> {
		const out = new Set<string>()
		for (const a of this.ctx.loader.api.anchors.list()) {
			const clean = this.path.toClean(a)
			if (clean.startsWith('\0')) continue
			if (clean.includes('/node_modules/')) continue
			out.add(clean)
		}
		return out
	}

	private isBridgeModule(specifier: string) {
		for (const pattern of this.deps.bridgeModules) {
			if (matchesSpecifierPattern(specifier, pattern)) return true
		}
		return false
	}

	private isHardBridgeModule(specifier: string) {
		return isHardBridgeSpecifier(specifier)
	}
}
