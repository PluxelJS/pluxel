import { existsSync } from 'node:fs'
import { availableParallelism, cpus } from 'node:os'
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
import {
	buildHmrViteConfig,
	type HMRDependencyConfig,
	type ResolvedHMRDependencyConfig,
	resolveFsAllowList,
	resolveHMRDependencyConfig,
} from './config'
import { HmrEnvironment, type HmrPathApi, type HmrToolkit } from './environment'
import {
	AsyncSerialLock,
	BatchDebouncer,
	findNearestPackageRoot,
	matchesSpecifierPattern,
	resolveGlobPatterns,
	setPkgrootCacheLimit,
	startTimer,
} from './internals'
import { collectHotspots, isLogEnabled, logAttributionReport, TimingTracker } from './logging'
import { buildHmrOperationalReport, type RegistryViewLike } from './operational-report'
import {
	collectColdStartEntries,
	HmrBatchProcessor,
	HmrExecutor,
	prefetchTransforms,
} from './pipeline'
import { HmrRunner, isHardBridgeSpecifier } from './runner'
import {
	installRequireShims,
	type RuntimeShimConfig,
	RuntimeShimRegistry,
} from './runtime-shims'

export interface HMRConfig {
	/** 业务扫描边界：默认仅这些目录下的 `.ts` 会被纳入 HMR 入口挑选（`.tsx`/`.jsx` 默认排除） */
	roots: string[]
	/** Enable operational report output. Defaults to `true`. */
	report?: boolean
	/** Limits workspace-specifier resolution attempts when building the operational report. */
	reportResolveLimit?: number
	/** Vite dev server port (use `0` to pick a random free port). */
	port?: number
	/**
	 * Cold-start warmup (best-effort).
	 *
	 * When enabled, `start()` will kick off warmup in background:
	 * - scan roots to collect likely entry modules
	 * - execute them once to register plugins and populate runner caches
	 */
	warmup?: boolean
	/**
	 * Warmup transform prefetch (via `ssrEnv.fetchModule`) primes Vite caches.
	 *
	 * Defaults to `true` for small warmups (<= 32 files).
	 */
	warmupPrefetch?: boolean
	/** Prefetch concurrency cap. Defaults to `min(fileCount, 8, cpuCores)`. */
	warmupPrefetchConcurrency?: number
	/**
	 * Attribution output (transform/evaluate/inject breakdown).
	 *
	 * - `true`: log at `info`
	 * - level string: `trace|debug|info|warn|error|fatal`
	 */
	attribution?: boolean | 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'
	/** HMR path normalization cache size. Defaults to `10_000`. */
	pathCacheLimit?: number
	/** Nearest package root cache size. Defaults to `2_000`. */
	pkgrootCacheLimit?: number
	/** Enable Vite dep optimization for the UI (client env). Defaults to `false`. */
	optimizeDeps?: boolean
	/** Enable Vite dep optimization for the SSR runner env. Defaults to `false`. */
	ssrOptimizeDeps?: boolean
	/** Custom Vite cacheDir (advanced). Defaults to Vite's own cacheDir. */
	viteCacheDir?: string
	/** Base URL for production UI assets (static renderer). */
	publicBase?: string
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
	/**
	 * SSR runner-only runtime shims (Vite pipeline).
	 *
	 * Defaults to `{}` (no shims). Use this only if you need to isolate side-effect-only modules
	 * in the SSR runner.
	 *
	 * Example (isolate `reflect-metadata` side effects in the runner):
	 * `runtimeShims: { 'reflect-metadata': true, 'reflect-metadata/*': true }`.
	 */
	runtimeShims?: Record<string, RuntimeShimConfig>
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
	private warnedBuiltinOverlap = false
	private baseline?: Promise<void>
	private startupScope?: Promise<{
		rootsAbs: readonly string[]
		rootsPretty: readonly string[]
		anchors: number
		entries: number
		entryList: readonly string[]
		entriesByRoot: readonly number[]
	}>
	private readonly execLock = new AsyncSerialLock()
	private warmupStarted = false
	private warmupPromise?: Promise<void>

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
		setPkgrootCacheLimit(this.config.pkgrootCacheLimit)
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
			pathCacheLimit: this.config.pathCacheLimit,
		})
		this.toolkit = this.env.toolkit
		this.path = this.toolkit.path

		this.deps = resolveHMRDependencyConfig(this.config.deps)

		const runtimeResolved: Record<string, RuntimeShimConfig> = this.config.runtimeShims ?? {}
		this.runtimeShims = new RuntimeShimRegistry({ shims: runtimeResolved })
		this.useRequireShims = this.runtimeShims.hasAny()
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
			this.timing.clear()
			await this.executor.runAndLoadAll(filesPath, keepOrder)
		})
		void this.logOperationalReport('executeFiles').catch((error) => {
			this.ctx.logger.warn('HMR report failed', { error })
		})
	}

	/**
	 * Warm up by collecting entries from configured roots and executing them once.
	 *
	 * This uses the same "cold start entry" logic as internal startup tooling:
	 * - prefer workspace entries when roots map to packages
	 * - fall back to `roots/**\/*.ts` otherwise
	 */
	public async warmup(opts?: { bestEffort?: boolean }): Promise<void> {
		const bestEffort = opts?.bestEffort ?? true
		if (!this.executor) {
			throw new Error('HMRService not initialized (Vite server not configured yet)')
		}
		await this.ensureBaseline()
		const p = (this.warmupPromise ??= this.performWarmup())
		try {
			await p
		} catch (error) {
			// Allow retry after failure.
			this.warmupPromise = undefined
			this.warmupStarted = false
			if (!bestEffort) throw error
			this.ctx.logger.error('warmup failed', { error })
		}
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
			port: this.config.port,
			deps: this.deps,
			extraPlugins: this.config.vitePlugins,
			runnerPlugin: this.plugin,
			honoPlugin: this.ctx.honoService.viteHonoDevServer,
			includeGlobs: this.includeGlobs,
			excludeGlobs: this.excludeGlobs,
			optimizeDepsEnabled: this.config.optimizeDeps === true,
			ssrOptimizeDepsEnabled: this.config.ssrOptimizeDeps === true,
			cacheDir: this.config.viteCacheDir,
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
		} catch (error) {
			await server.close().catch(() => undefined)
			throw error
		}

		server.printUrls()
		this.ctx.logger.info`HMR 服务已启动，只监听：${this.config.roots.join(', ')}`
		// Default operational report: info-level, counts only.
		// Best-effort and must never block startup.
		void this.logOperationalReport('startup').catch((error) => {
			this.ctx.logger.warn('HMR report failed', { error })
		})

		if (this.shouldAutoWarmup()) this.startWarmup()
	}

	private shouldAutoWarmup(): boolean {
		return this.config.warmup === true
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
		// Ensure on-disk config is loaded before any "enabled in config" decisions happen.
		// (warmup/executeFiles/batches rely on it).
		//
		// Note: some tests construct a partial/mock context without ConfigService; tolerate that.
		const configService = (
			this.ctx as unknown as { configService?: { isReady?: boolean; ready?: Promise<void> } }
		).configService
		if (configService?.ready && configService.isReady !== true) await configService.ready

		// 1) Bridge host modules (singleton identity).
		await this.bridgeHostModules()

		// 2) Establish builtin baseline (so later batch rollbacks fall back to it).
		await this.preloadBuiltins()
	}

	private startWarmup() {
		if (this.warmupStarted) return
		this.warmupStarted = true
		// Warmup is best-effort: it must never prevent the host from running once baseline is correct.
		const p = (this.warmupPromise ??= this.performWarmup())
		void p.catch((error) => {
			this.ctx.logger.error('warmup failed', { error })
			// Allow retry after failure in dev environments.
			this.warmupPromise = undefined
			this.warmupStarted = false
		})
	}

	private async preloadBuiltins(): Promise<void> {
		if (this.didPreloadBuiltins) return
		this.didPreloadBuiltins = true

		const builtins = this.config.builtins
		if (!builtins?.length) return

		this.maybeWarnBuiltinOverlap()

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

	private maybeWarnBuiltinOverlap() {
		if (this.warnedBuiltinOverlap) return
		const builtins = this.config.builtins
		if (!builtins?.length) return

		const isUnder = (child: string, root: string) =>
			child === root || child.startsWith(root.endsWith('/') ? root : `${root}/`)

		// Common monorepo layout: built-in plugin sources live under `packages/plugins/*`.
		// If users set scan roots to the workspace root (pnpm workspace), those sources get picked up
		// by path-based scanning and can conflict with the synthetic builtin module id.
		const candidates = ['packages/plugins', 'packages/plugin', 'packages/builtins']
		const overlaps: string[] = []
		for (const rel of candidates) {
			const abs = normalizePath(resolve(this.cwd, rel))
			if (!existsSync(abs)) continue
			if (this.scanRootsAbs.some((root) => isUnder(abs, root))) overlaps.push(rel)
		}
		if (!overlaps.length) return

		this.warnedBuiltinOverlap = true
		this.ctx.logger.warn(
			'hmrService.builtins 与 hmrService.roots/include 可能发生“重复加载”冲突（检测到扫描范围覆盖 {dirs}）。' +
				' builtins 会以合成 moduleId（如 "pluxel:builtins"）建立 baseline；若同一插件源码又被按文件路径扫描执行，可能触发插件名冲突或双注册。' +
				' 建议：1) 从扫描范围排除这些 builtin 插件目录（hmrService.exclude）；或 2) 移除 builtins，让它们由扫描/HMR 管理；' +
				' 注意 deps.bridgeModules 仅影响“按 specifier 导入”的单例，不会阻止按路径扫描。',
			{ dirs: overlaps.join(', ') },
		)
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
		return this.ctx.loader.api.anchors.has(clean)
	}

	private async performWarmup() {
		await this.execLock.run(async () => {
			this.timing.clear()
			const endAll = startTimer()
			const endScan = startTimer()
			const scope = await this.ensureStartupScope()
			const scanMs = Math.round(endScan() * 10) / 10
			const coldFiles = scope.entryList.slice().sort()
			const dbgWarmup = this.dbg.warmup
			const debugWarmup = isLogEnabled(dbgWarmup, 'debug')
			if (debugWarmup) {
				dbgWarmup.debug((l) => l`scan: ${coldFiles.length} files in ${scanMs}ms`)
			}

			const endWarmup = startTimer()
			let prefetchMs: number | undefined
			let prefetchPromise: Promise<void> | undefined
			let endPrefetch: (() => number) | undefined
			if (this.shouldWarmupPrefetch(coldFiles.length)) {
				endPrefetch = startTimer()
				prefetchPromise = prefetchTransforms({
					env: this.ssrEnv,
					ids: coldFiles,
					timing: this.timing,
					concurrency: this.resolveWarmupPrefetchConcurrency(coldFiles.length),
				})
			}

			if (debugWarmup) {
				dbgWarmup.debug((l) => {
					const prettyFiles = coldFiles.map((f) => this.path.pretty(f))
					return l`files (${prettyFiles.length})\n${prettyFiles.map((f) => `    ${f}`).join('\n')}`
				})
			}

			const executed = await this.executor.runAndLoadAllClean(coldFiles, true)
			if (prefetchPromise) {
				// Overlap transform prefetch with evaluation to reduce warmup wall time.
				// Await it after evaluation so we don't leave background work behind.
				await prefetchPromise.catch(() => undefined)
				prefetchMs = Math.round((endPrefetch?.() ?? 0) * 10) / 10
			}
			const commitMs = executed ? Math.round(executed.commitMs * 10) / 10 : null

			const warmupMs = Math.round(endWarmup() * 10) / 10
			const totalMs = Math.round(endAll() * 10) / 10

			const hotspots = collectHotspots(this.timing, (id) => this.path.pretty(id))

			this.ctx.logger.info('HMR warmup done', {
				files: coldFiles.length,
				scanMs,
				prefetchMs,
				warmupMs,
				commitMs,
				totalMs,
				hotspots: hotspots.length ? hotspots : undefined,
			})

			// Post-warmup operational report (counts + hotspots) is helpful for demo hosts and profiling.
			void this.logOperationalReport('warmup').catch((error) => {
				this.ctx.logger.warn('HMR report failed', { error })
			})

			// Attribution output is opt-in for profiling.
			const attr = this.config.attribution
			if (attr) {
				const level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' =
					attr === true ? 'info' : attr
				logAttributionReport(
					this.ctx.logger,
					{
						changed: coldFiles[0] ?? 'N/A',
						targets: coldFiles,
						timing: this.timing,
						prettyId: (id) => this.path.pretty(id),
					},
					{ level },
				)
			}
		})
	}

	private shouldWarmupPrefetch(fileCount: number) {
		if (fileCount <= 1) return false
		if (this.config.warmupPrefetch !== undefined) return this.config.warmupPrefetch
		// Default: enable prefetch for small warmups to reduce wall time.
		return fileCount <= 32
	}

	private resolveWarmupPrefetchConcurrency(fileCount: number) {
		const parsed = this.config.warmupPrefetchConcurrency
		if (typeof parsed === 'number' && Number.isFinite(parsed) && parsed > 0) {
			return Math.min(fileCount, Math.floor(parsed))
		}
		const cores =
			(typeof availableParallelism === 'function' ? availableParallelism() : cpus().length) || 1
		return Math.min(fileCount, 8, Math.max(1, cores))
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
		if (!byImporter) {
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
		// Evict by specifier insertion order (FIFO) to keep per-hit overhead minimal.
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
		return this.ctx.loader.api.anchors.snapshot()
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

	private shouldLogOperationalReport() {
		return this.config.report !== false
	}

	private async ensureStartupScope() {
		if (this.startupScope) return await this.startupScope
		this.startupScope = (async () => {
			const anchorsClean = this.getAnchorsCleanSnapshot()
			const entries = await collectColdStartEntries({
				rootsAbs: this.scanRootsAbs,
				anchors: anchorsClean,
				path: this.path,
				pathFilter: (id) => this.toolkit.pathFilter(id),
				scanService: this.ctx.scanService,
				workspaceConditions: this.workspaceConditions,
			})
			// `collectColdStartEntries()` already returns clean, de-duplicated ids
			// and applies the same pathFilter for non-anchor entries.

			const rootsAbs = this.scanRootsAbs.slice().sort()
			const rootsPretty = rootsAbs.map((root) => this.path.pretty(root))
			const entriesByRoot = new Array<number>(rootsAbs.length).fill(0)
			const isUnder = (child: string, root: string) =>
				child === root || child.startsWith(root.endsWith('/') ? root : `${root}/`)

			for (const id of entries) {
				for (let i = 0; i < rootsAbs.length; i++) {
					if (isUnder(id, rootsAbs[i]!)) {
						entriesByRoot[i] = (entriesByRoot[i] ?? 0) + 1
						break
					}
				}
			}

			return {
				rootsAbs,
				rootsPretty,
				anchors: anchorsClean.size,
				entries: entries.length,
				entryList: entries,
				entriesByRoot,
			} as const
		})()
		return await this.startupScope
	}

	private async logOperationalReport(reason: 'startup' | 'executeFiles' | 'warmup') {
		if (!this.shouldLogOperationalReport()) return

		type LoaderApiLike = { registry: RegistryViewLike }
		type CtxWithLoaderApi = { loader?: { api?: LoaderApiLike } }

		const registryView = (this.ctx as unknown as CtxWithLoaderApi).loader?.api?.registry
		if (!registryView) return

		const scope = await this.ensureStartupScope()
		const hotspots =
			reason === 'executeFiles' ? collectHotspots(this.timing, (id) => this.path.pretty(id)) : []

		const report = await buildHmrOperationalReport({
			reason,
			cwd: this.cwd,
			anchors: scope.anchors,
			entries: scope.entries,
			rootsAbs: scope.rootsAbs,
			rootsPretty: scope.rootsPretty,
			entriesByRoot: scope.entriesByRoot,
			registryView,
			isEnabledInConfig: (name) => this.ctx.configService.isEnabledInConfig(name),
			isRunning: (ctor) => this.ctx.registry.isRunning(ctor),
			resolveBareWorkspaceEntry: (specifier) => this.resolveBareWorkspaceEntry(specifier, null),
			resolveLimit: this.config.reportResolveLimit,
			hotspots: hotspots.length ? hotspots : undefined,
		})

		this.ctx.logger.info('HMR report', report)
	}
}
