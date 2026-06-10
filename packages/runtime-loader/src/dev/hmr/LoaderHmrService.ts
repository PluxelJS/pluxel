import { existsSync } from 'node:fs'
import { availableParallelism, cpus } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { Logger as LogtapeLogger } from '@logtape/logtape'
import { type CommitSummary, type Context, checkPluginDecorator, getPluginInfo } from '@pluxel/core'
import { dirname, resolve } from 'pathe'
import {
	createServer,
	type DevEnvironment,
	normalizePath,
	type Plugin,
	type ViteDevServer,
} from 'vite'
import type { BuiltinPluginSpec } from '@pluxel/runtime-loader/services'
import {
	PLUXEL_LOADER_DEV_WORKSPACE_CONDITIONS_WITH_SOURCE,
	findNearestPackageRoot,
	resolveGlobPatterns,
	setPkgrootCacheLimit,
	startTimer,
} from '@pluxel/runtime/shared'
import {
	buildLoaderHmrViteConfig,
	type LoaderHmrDependencyConfig,
	type ResolvedLoaderHmrDependencyConfig,
	resolveFsAllowList,
	resolveLoaderHmrDependencyConfig,
} from './config'
import { HmrEnvironment, type HmrPathApi, type HmrToolkit } from './environment'
import { AsyncSerialLock, BatchDebouncer, matchesSpecifierPattern } from './internals'
import { collectHotspots, isLogEnabled, logAttributionReport, TimingTracker } from './logging'
import { buildHmrOperationalReport } from './operational-report'
import {
	HmrBatchProcessor,
	type HmrBatchSummary,
	HmrExecutor,
	prefetchTransforms,
} from './pipeline'
import { HmrRunner, isHardBridgeSpecifier } from './runner'
import { installRequireShims, type RuntimeShimConfig, RuntimeShimRegistry } from './runtime-shims'
import { WorkspaceEntryResolver } from './workspace-entry-resolver'
import { createFetchDevServerPlugin } from '../vite-fetch-plugin'

export interface LoaderHmrConfig {
	/** 业务扫描边界：HMR 只监听这些 roots（用于过滤 watcher 事件、分组报告等）。 */
	roots: string[]
	/** Whether to print Vite dev server URLs on startup. Defaults to `true`. */
	printUrls?: boolean
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
	 * - execute `entries` once to register plugins and populate runner caches
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
	/** HMR runner internal cache size. Defaults to `10_000`. */
	runnerCacheLimit?: number
	/** Nearest package root cache size. Defaults to `2_000`. */
	pkgrootCacheLimit?: number
	/** Enable Vite dep optimization for the UI (client env). Defaults to `false`. */
	optimizeDeps?: boolean
	/** Enable Vite dep optimization for the SSR runner env. Defaults to `false`. */
	ssrOptimizeDeps?: boolean
	/** Custom Vite cacheDir (advanced). Defaults to Vite's own cacheDir. */
	viteCacheDir?: string
	/**
	 * 额外的 HMR include glob（优先级高于默认的 `roots/**` + `.ts`）。
	 * - 需要完整路径或相对 cwd 的 glob
	 * - 适用于强制隔离“插件 HMR”与“前端 HMR”
	 */
	include?: string[]
	/**
	 * 冷启动入口清单（稳定顺序）。
	 *
	 * 治理规则：HMR 不做任何“文件系统兜底发现”，入口列表必须由上层（workspace profiles/CLI/host）
	 * 生成并显式传入，避免“扫描两套理论”与隐式行为。
	 */
	entries: string[]
	/**
	 * 额外的 HMR exclude glob（默认已排除 `node_modules`/`.d.ts`）。
	 * - 需要完整路径或相对 cwd 的 glob
	 */
	exclude?: string[]
	/** 额外允许 Vite Dev Server 访问的目录（绝对路径或会基于 cwd 解析的相对路径） */
	fsAllow?: string[]
	/**
	 * Browser entry sources served by the HMR dev server.
	 *
	 * These are fed into Vite's client-side dep optimizer so browser imports do not fall back to raw
	 * CommonJS `/@fs/.../node_modules/*` files.
	 *
	 * Paths may be absolute or relative to `cwd`.
	 */
	clientEntries?: string[]
	/** 依赖相关配置（external / bridge / optimizeDeps 等） */
	deps?: LoaderHmrDependencyConfig
	/**
	 * When commit fails due to missing dependencies, automatically disable the offending plugins
	 * (persisted) and retry commit so the rest of the batch can still load.
	 *
	 * @default true
	 */
	commitAutoDisableMissingDependencies?: boolean
	/**
	 * Safety cap for commit auto-disable retries.
	 *
	 * @default 8
	 */
	commitAutoDisableMaxPasses?: number
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
	 * Builtin plugins loaded from workspace package dist entries (named exports).
	 *
	 * This form is designed for monorepos where `@pluxel/runtime` should not directly depend on builtin packages,
	 * while still preserving **constructor identity** inside the SSR runner (so `features.dep(BuiltinCtor)`
	 * works reliably).
	 *
	 * The host resolves each `entry` path (from `exports["."]`, e.g. `dist/index.mjs`) and HMR evaluates
	 * it via the runner, then commits all detected plugin ctors via `LoaderService.preloadPlugins()`.
	 */
	builtinsFromDist?: ReadonlyArray<{
		/** Workspace package name (also used as Loader moduleId). */
		packageName: string
		/** Dist entry file path (absolute or workspace-relative). Prefer `.mjs`. */
		entry: string
		/**
		 * Optional export key.
		 *
		 * Note: when omitted, HMR auto-detects all `@Plugin`-decorated constructors from the module's
		 * **named exports** (fail-fast; does not rely on default export).
		 */
		exportKey?: string
		/** Whether to enable this builtin in config. Defaults to `true`. */
		enable?: boolean
	}>
	/**
	 * Builtins preload policy:
	 * - `true`: fail-fast if builtin preload commit fails (host startup crashes).
	 * - `false`: best-effort; commit failures are logged and ignored (UI remains available).
	 *
	 * @default false
	 */
	builtinsPreloadStrict?: boolean
	/**
	 * When `builtinsPreloadStrict=false`, automatically disable plugins that fail DI verification
	 * due to missing dependencies, then retry preload with remaining enabled plugins.
	 *
	 * @default true
	 */
	builtinsAutoDisableMissingDependencies?: boolean
	/**
	 * Safety cap for builtins auto-disable retries.
	 *
	 * @default 8
	 */
	builtinsAutoDisableMaxPasses?: number
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

const unique = <T>(iter: Iterable<T>) => [...new Set(iter)]

export type HmrWaitForBatchOptions = {
	/**
	 * Wait for a batch with `epoch > afterEpoch`.
	 *
	 * Defaults to the current `lastBatch.epoch` (i.e. "wait for the next batch").
	 */
	afterEpoch?: number
	/** Timeout in milliseconds. Defaults to 30_000. */
	timeoutMs?: number
	/** Optional abort signal. */
	signal?: AbortSignal
}

export type HmrWaitForStableOptions = HmrWaitForBatchOptions & {
	/**
	 * Quiet window in milliseconds.
	 *
	 * After observing a batch, `waitForStable()` will keep waiting until no newer batch arrives for `quietMs`,
	 * then return the most recent batch summary.
	 *
	 * Defaults to `250`.
	 */
	quietMs?: number
}

export type HmrWaitForIdleOptions = {
	/** Timeout in milliseconds. Defaults to 30_000. */
	timeoutMs?: number
	/** Optional abort signal. */
	signal?: AbortSignal
}

export type HmrRuntimeApi = {
	lastBatch(): HmrBatchSummary | null
	waitForBatch(options?: HmrWaitForBatchOptions): Promise<HmrBatchSummary>
	waitForStable(options?: HmrWaitForStableOptions): Promise<HmrBatchSummary>
	waitForIdle(options?: HmrWaitForIdleOptions): Promise<void>
}

type HmrBatchWaiter = {
	afterEpoch: number
	resolve: (summary: HmrBatchSummary) => void
	reject: (error: unknown) => void
	cleanup: () => void
}

export class LoaderHmrService {
	public vite!: ViteDevServer
	private startPromise?: Promise<void>
	private readonly serverConfigured: Promise<void>
	private serverConfiguredResolve: () => void = () => {}
	private serverConfiguredReject: (error: unknown) => void = () => {}

	private ssrEnv!: DevEnvironment
	private readonly runner = new HmrRunner()
	private readonly scanService: Context['scanService']
	private executor!: HmrExecutor
	private batchProcessor!: HmrBatchProcessor

	private readonly cwd = process.cwd()
	private readonly scanRootsAbs: string[]
	private readonly env: HmrEnvironment
	public readonly toolkit: HmrToolkit
	public readonly path: HmrPathApi
	private readonly includeGlobs?: string[]
	private readonly excludeGlobs?: string[]
	private readonly builtinDistDirsClean: readonly string[]

	private readonly deps: ResolvedLoaderHmrDependencyConfig
	private readonly runtimeShims: RuntimeShimRegistry
	private readonly useRequireShims: boolean

	private readonly timing: TimingTracker

	private readonly workspaceEntryResolver: WorkspaceEntryResolver
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
	private readonly workspaceConditions: readonly string[] = Object.freeze([
		...PLUXEL_LOADER_DEV_WORKSPACE_CONDITIONS_WITH_SOURCE,
	])

	/**
	 * Stable, minimal surface for external callers (UI/RPC/MCP/tooling).
	 *
	 * This intentionally avoids exposing the Vite server directly.
	 */
	public readonly api: HmrRuntimeApi
	private lastBatchSummary: HmrBatchSummary | null = null
	private readonly batchWaiters = new Set<HmrBatchWaiter>()
	private inFlightBatchEpoch: number | null = null
	private readonly commitByBatchEpoch = new Map<number, CommitSummary>()

	constructor(
		public ctx: Context,
		private readonly config: LoaderHmrConfig,
	) {
		this.scanService = this.ctx.scanService
		if (!Array.isArray(this.config.entries)) {
			throw new TypeError(
				'[hmr] loaderHmr.entries must be string[] (explicit cold-start entry list)',
			)
		}

		setPkgrootCacheLimit(this.config.pkgrootCacheLimit)
		this.serverConfigured = new Promise<void>((resolveServerConfigured, rejectServerConfigured) => {
			this.serverConfiguredResolve = () => {
				this.serverConfiguredResolve = () => {}
				this.serverConfiguredReject = () => {}
				resolveServerConfigured()
			}
			this.serverConfiguredReject = (error) => {
				this.serverConfiguredResolve = () => {}
				this.serverConfiguredReject = () => {}
				rejectServerConfigured(error)
			}
		})

		this.scanRootsAbs = unique(
			this.config.roots.map((dir) => normalizePath(resolve(this.cwd, dir))),
		)
		this.includeGlobs = resolveGlobPatterns(this.config.include, this.cwd)
		this.excludeGlobs = resolveGlobPatterns(this.config.exclude, this.cwd)
		this.env = new HmrEnvironment({
			cwd: this.cwd,
			scanRootsAbs: this.scanRootsAbs,
			includeGlobs: this.includeGlobs,
			excludeGlobs: this.excludeGlobs,
			pathCacheLimit: this.config.pathCacheLimit,
		})
		this.toolkit = this.env.toolkit
		this.path = this.toolkit.path
		this.builtinDistDirsClean = this.resolveBuiltinDistDirsClean()
		this.workspaceEntryResolver = new WorkspaceEntryResolver(
			this.scanService,
			this.path,
			this.workspaceConditions,
		)

		this.deps = resolveLoaderHmrDependencyConfig(this.config.deps, {
			cwd: this.cwd,
			resolveCache: this.scanService.resolverCache,
		})

		const runtimeResolved: Record<string, RuntimeShimConfig> = this.config.runtimeShims ?? {}
		this.runtimeShims = new RuntimeShimRegistry({ shims: runtimeResolved })
		this.useRequireShims = this.runtimeShims.hasAny()
		if (this.useRequireShims) installRequireShims((id) => this.runtimeShims.require(id))

		const getDebugChannel = (topic: string): LogtapeLogger => this.ctx.logger.getDebugChannel(topic)

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

		this.api = {
			lastBatch: () => this.lastBatchSummary,
			waitForBatch: (options) => this.waitForBatch(options),
			waitForStable: (options) => this.waitForStable(options),
			waitForIdle: (options) => this.waitForIdle(options),
		}

		this.attachCommitTracker()
		this.attachResolverCacheInvalidation()
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
			throw new Error('LoaderHmrService not initialized (Vite server not configured yet)')
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
	 * Warm up by executing the configured cold-start `entries` (plus anchors).
	 *
	 * Governance: HMR does not do filesystem discovery; `entries` must be resolved by upper layers
	 * (workspace profiles / CLI / host) and passed explicitly.
	 */
	public async warmup(opts?: { bestEffort?: boolean }): Promise<void> {
		const bestEffort = opts?.bestEffort ?? true
		if (!this.executor) {
			throw new Error('LoaderHmrService not initialized (Vite server not configured yet)')
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

	public async close(): Promise<void> {
		const server = (this as unknown as { vite?: ViteDevServer }).vite
		if (!server) return
		await server.close().catch((): undefined => undefined)
		this.startPromise = undefined
	}

	private async startImpl(): Promise<void> {
		const serverFsAllow = resolveFsAllowList({
			cwd: this.cwd,
			cwdNormalized: this.env.paths.cwdNormalizedPath,
			scanRoots: this.scanRootsAbs,
			configFsAllow: Array.isArray(this.config.fsAllow) ? this.config.fsAllow : undefined,
			hmrPackageRoot,
		})
		const clientEntries = this.config.clientEntries?.map((entry) =>
			normalizePath(resolve(this.cwd, entry)),
		)
		const serverConfig = buildLoaderHmrViteConfig({
			// Vite root should point at the HMR package UI, not the host cwd.
			// Otherwise dep optimization may not crawl the correct entries and will try to update deps at runtime.
			root: hmrPackageRoot ?? this.cwd,
			fsAllow: serverFsAllow,
			clientEntries,
			port: this.config.port,
			deps: this.deps,
			extraPlugins: this.config.vitePlugins,
			runnerPlugin: this.plugin,
			httpPlugin: createFetchDevServerPlugin({
				exclude: [
					/^\/@.+$/,
					/^\/node_modules\/.*/,
					/(\.ts|\.tsx)(\?.*)?$/,
					/^\/favicon\.ico$/,
					/^\/static\/.+/,
					/\?t=\d+$/,
				],
				fetch: (req) => this.ctx.http.fetch(req),
				handleHotUpdate: ({ server }) => {
					if (this.ctx.http.consumeFullReloadRequest()) {
						server.ws.send({ type: 'full-reload' })
					}
					return []
				},
			}),
			optimizeDepsEnabled: this.config.optimizeDeps === true,
			ssrOptimizeDepsEnabled: this.config.ssrOptimizeDeps === true,
			cacheDir: this.config.viteCacheDir,
		})
		const server = await createServer(serverConfig)
		// Bind server shutdown to host lifetime (CLI agent runs call `ctx.effects.dispose()`).
		this.ctx.effects.defer(() => server.close().catch((): undefined => undefined), {
			tag: 'LoaderHmrService.viteServer',
			phase: 'shutdown',
		})
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
			await server.close().catch((): undefined => undefined)
			throw error
		}

		if (this.config.printUrls !== false) server.printUrls()
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
		const builtinsFromDist = this.config.builtinsFromDist?.length
			? new Map(
					this.config.builtinsFromDist.map((b) => [
						String(b.packageName ?? '').trim(),
						String(b.entry ?? '').trim(),
					]),
				)
			: null

		const plugin: Plugin = {
			name: 'pluxel-runner',
			enforce: 'pre',
			apply: 'serve',

			configureServer: async (server) => this.configureServer(server),

			resolveId: async (id, _importer, options) => {
				// Hard isolation: runner-only resolution must never affect the client environment
				// (the dev server also serves a browser UI + extension compilation).
				if (!options?.ssr) return null

				const shimResolved = this.runtimeShims.resolveId(id)
				if (shimResolved) return shimResolved

				// Never let workspace resolution rewrite bridged singleton modules, otherwise we may end up
				// evaluating a second copy (e.g. workspace TS sources) in the runner.
				if (this.isHardBridgeModule(id) || this.isBridgeModule(id)) {
					return null
				}

				// Builtins from dist: keep them stable and consistent across the runner cache.
				// This avoids rewriting them to HMR/source TS entries which would
				// produce a different ctor identity and break `features.dep(BuiltinCtor)` integrations.
				const builtinEntry = builtinsFromDist?.get(id)
				if (builtinEntry) {
					const clean = this.path.toClean(builtinEntry)
					return clean ? { id: clean } : null
				}

				const resolved = await this.workspaceEntryResolver.resolveBareWorkspaceEntry(id)
				if (resolved) return { id: resolved }
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
			this.serverConfiguredResolve()
		} catch (error) {
			this.serverConfiguredReject(error)
			throw error
		}
	}

	private configureRunner(server: ViteDevServer) {
		this.runner.init(server, {
			cacheLimit: this.config.runnerCacheLimit,
			hostCwd: this.cwd,
			cjsExternal: this.deps.cjsExternal,
			bridgeModules: this.deps.bridgeModules,
			bridgeProviders: this.deps.bridgeProviders,
			skipPlugin: this.plugin,
			resolveCache: this.scanService.resolverCache,
			workspaceConditions: this.workspaceConditions,
		})
		this.ssrEnv = this.runner.env
	}

	private async bridgeHostModules() {
		await this.runner.bridgeHostModules(this.deps.bridgeModules, this.path, {
			warn: (message, props) => this.ctx.logger.warn(message, props),
		})
		await this.runner.assertBridgedSingletons(this.deps.bridgeModules)
	}

	private configurePipeline() {
		this.executor = new HmrExecutor(this.ctx, this.runner, this.path, this.timing, {
			dbgModules: this.dbg.modules,
			useRequireShims: this.useRequireShims,
			autoDisableMissingDependencies: this.config.commitAutoDisableMissingDependencies ?? true,
			autoDisableMaxPasses: this.config.commitAutoDisableMaxPasses ?? 8,
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
				// Keep runtime evaluation fast and quiet by default.
				// Per-batch attribution report is opt-in via `LoaderHmrConfig.attribution`
				// (or `PLUXEL_DEV_ATTRIBUTION`).
				attributionLevel: (() => {
					const attr = this.config.attribution
					if (!attr) return 'off'
					return attr === true ? 'info' : attr
				})(),
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
		const configService = this.ctx.configService
		if (!configService.isReady) await configService.ready

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

		const builtins = this.config.builtins ?? []
		const builtinsFromDist = this.config.builtinsFromDist ?? []
		if (builtins.length === 0 && builtinsFromDist.length === 0) return

		this.maybeWarnBuiltinOverlap()

		const config = this.ctx.configService
		if (!config.isReady) await config.ready

		try {
			const resolved: BuiltinPluginSpec[] = []
			const builtinsByPackage: Record<string, string[]> = {}
			const builtinPlugins: string[] = []
			const builtinPluginSet = new Set<string>()

			if (builtinsFromDist.length > 0) {
				const specs = builtinsFromDist
					.map((b) => ({
						packageName: String(b.packageName ?? '').trim(),
						exportKey: String(b.exportKey ?? '').trim(),
						enable: b.enable !== false,
						entry: String(b.entry ?? '').trim(),
					}))
					.filter((b) => b.packageName)

				const exportsList = await Promise.all(
					specs.map(async (b) => {
						try {
							return await this.runner.import(b.packageName)
						} catch (error) {
							throw new Error(
								`[hmr] Failed to evaluate builtin "${b.packageName}" via runner import (entry=${b.entry || 'unknown'}).`,
								{ cause: error },
							)
						}
					}),
				)

				for (let i = 0; i < specs.length; i++) {
					const b = specs[i]!
					const exportsNamespace = exportsList[i]
					if (!exportsNamespace || typeof exportsNamespace !== 'object') {
						throw new Error(
							`[hmr] Builtin "${b.packageName}" did not evaluate to an ESM exports object.`,
						)
					}
					const exports = exportsNamespace as Record<string, unknown>

					// Governance (fail-fast): do not rely on default export.
					// Builtin packages may export multiple plugins; we auto-detect all decorated plugin ctors
					// from *named* exports.
					const keys = Object.keys(exports)
					const pluginKeys: string[] = []
					const pushIfPlugin = (k: string) => {
						if (!k || k === 'default') return
						const maybe = exports[k]
						if (typeof maybe !== 'function') return
						if (!checkPluginDecorator(maybe as any)) return
						pluginKeys.push(k)
					}

					if (b.exportKey) {
						if (b.exportKey === 'default') {
							throw new Error(
								`[hmr] Builtin "${b.packageName}" cannot use exportKey="default". Export the plugin ctor as a named export.`,
							)
						}
						pushIfPlugin(b.exportKey)
						if (pluginKeys.length === 0) {
							throw new Error(
								`[hmr] Builtin "${b.packageName}" export "${b.exportKey}" is not an @Plugin ctor.` +
									(keys.length > 0 ? ` Available keys: ${keys.slice(0, 16).join(', ')}` : ''),
							)
						}
					} else {
						for (const k of keys) pushIfPlugin(k)
						pluginKeys.sort((leftKey, rightKey) => leftKey.localeCompare(rightKey))
						if (pluginKeys.length === 0) {
							throw new Error(
								`[hmr] Builtin "${b.packageName}" exports no @Plugin ctors as named exports.` +
									' Export at least one plugin ctor as a named export (do not rely on default).' +
									(keys.length > 0 ? ` Available keys: ${keys.slice(0, 16).join(', ')}` : ''),
							)
						}
					}

					const ids: string[] = []
					for (const exportKey of pluginKeys) {
						const ctor = exports[exportKey] as any
						try {
							const id = getPluginInfo(ctor as never).id
							ids.push(id)
							if (!builtinPluginSet.has(id)) {
								builtinPluginSet.add(id)
								builtinPlugins.push(id)
							}
						} catch {
							// Should not happen: pluginKeys only includes decorated ctors.
							ids.push(exportKey)
						}
						resolved.push({
							plugin: ctor as any,
							enable: b.enable,
							// Use the workspace package name so snapshots can be generated as runnable imports.
							moduleId: b.packageName,
							packageName: b.packageName,
							exportKey,
						})
					}
					builtinsByPackage[b.packageName] = ids
				}
			}

			if (builtins.length > 0) resolved.push(...builtins)
			// Commit builtins as a baseline so later loader batch rollbacks revert back to a container
			// that already includes the built-in plugins.
			const declared = await this.ctx.loader.preloadPlugins(resolved, {
				commit: true,
				strict: this.config.builtinsPreloadStrict ?? false,
				autoDisableMissingDependencies: this.config.builtinsAutoDisableMissingDependencies ?? true,
				autoDisableMaxPasses: this.config.builtinsAutoDisableMaxPasses ?? 8,
			})

			if (builtinsFromDist.length > 0) {
				this.ctx.logger.info('Builtin baseline ready (from dist)', {
					packages: builtinsFromDist.length,
					plugins: builtinPlugins.length,
					builtins: builtinsByPackage,
					builtinPlugins,
				})
			}
			if (builtins.length > 0 && builtinsFromDist.length === 0) {
				this.ctx.logger.info(`Builtin baseline ready: ${declared.length} plugin(s)`)
			}
		} catch (error) {
			// Allow a retry on the next start cycle (or in tests) when configuration changes.
			this.didPreloadBuiltins = false
			throw error
		}
	}

	private maybeWarnBuiltinOverlap() {
		if (this.warnedBuiltinOverlap) return
		const builtins = this.config.builtins ?? []
		const builtinsFromDist = this.config.builtinsFromDist ?? []
		if (builtins.length === 0 && builtinsFromDist.length === 0) return

		const isUnder = (child: string, root: string) =>
			child === root || child.startsWith(root.endsWith('/') ? root : `${root}/`)

		// Common monorepo layout: built-in plugin sources live under `packages/plugins/*`.
		// If users set scan roots to the workspace root (pnpm workspace), those sources get picked up
		// by path-based scanning and can conflict with the synthetic builtin module id.
		const candidates = [
			'packages/plugins',
			'packages/plugin',
			'packages/builtins',
			'builtin-plugins',
		]
		const overlaps: string[] = []
		for (const rel of candidates) {
			const abs = normalizePath(resolve(this.cwd, rel))
			if (!existsSync(abs)) continue
			if (this.scanRootsAbs.some((root) => isUnder(abs, root))) overlaps.push(rel)
		}
		if (overlaps.length === 0) return

		this.warnedBuiltinOverlap = true
		this.ctx.logger.warn(
			'loaderHmr.builtins/builtinsFromDist 与 loaderHmr.roots/include 可能发生“重复加载”冲突（检测到扫描范围覆盖 {dirs}）。' +
				' builtins 会以 moduleId（builtins: "pluxel:builtins"；builtinsFromDist: packageName）建立 baseline；若同一插件源码又被按文件路径扫描执行，可能触发插件名冲突或双注册。' +
				' 建议：1) 从扫描范围排除这些 builtin 插件目录（loaderHmr.exclude）；或 2) 移除 builtins，让它们由扫描/loader HMR 管理；' +
				' 注意 deps.bridgeModules 仅影响“按 specifier 导入”的单例，不会阻止按路径扫描。',
			{ dirs: overlaps.join(', ') },
		)
	}

	private setupBatching() {
		this.debouncer = new BatchDebouncer(
			async (files, epoch) => {
				await this.ensureBaseline()
				this.inFlightBatchEpoch = epoch
				try {
					const summary = await this.execLock.run(() => this.batchProcessor.process(files, epoch))
					if (!summary) return
					const enriched = this.enrichBatchSummary(summary, epoch)
					this.onBatchSummary(enriched)
				} finally {
					this.inFlightBatchEpoch = null
					this.commitByBatchEpoch.delete(epoch)
				}
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
		// Governance: builtinsFromDist establish a baseline container and are intentionally not managed
		// by the HMR pipeline. Ignore any changes under builtin dist dirs to avoid double-registration.
		if (clean && this.isInBuiltinDist(clean)) return false
		if (this.toolkit.pathFilter(clean)) {
			this.debouncer.push(clean)
			return true
		}
		if (this.isAnchorClean(clean)) {
			this.debouncer.push(clean)
			return true
		}
		// Dynamic dependency tracking: once a file is part of the runner module graph,
		// accept changes even if it is outside the initial include globs.
		// This keeps `roots/includeGlobs` minimal without losing "dependency edits trigger reload".
		const env = this.ssrEnv
		const graph = env?.moduleGraph
		if (graph) {
			const variants = this.path.variantsClean
				? this.path.variantsClean(clean)
				: this.path.variants(clean)
			for (const variant of variants) {
				const mods = graph.getModulesByFile(variant)
				if (mods?.size) {
					this.debouncer.push(clean)
					return true
				}
			}
		}
		return false
	}

	private resolveBuiltinDistDirsClean(): readonly string[] {
		const list = this.config.builtinsFromDist ?? []
		if (list.length === 0) return []
		const out: string[] = []
		for (const b of list) {
			const entry = typeof b?.entry === 'string' ? b.entry.trim() : ''
			if (!entry) continue
			const clean = this.path.toClean(entry)
			if (!clean) continue
			out.push(dirname(clean))
		}
		return unique(out).sort((a, b) => a.localeCompare(b))
	}

	private isInBuiltinDist(clean: string): boolean {
		for (const dir of this.builtinDistDirsClean) {
			if (clean === dir) return true
			const prefix = dir.endsWith('/') ? dir : `${dir}/`
			if (clean.startsWith(prefix)) return true
		}
		return false
	}

	private isAnchorClean(clean: string): boolean {
		return this.ctx.loader.api.anchors.has(clean)
	}

	private attachCommitTracker() {
		this.ctx.on('afterCommit', (summary: CommitSummary) => {
			const epoch = this.inFlightBatchEpoch
			if (epoch !== null) {
				this.commitByBatchEpoch.set(epoch, summary)
			}
		})
	}

	private attachResolverCacheInvalidation() {
		this.ctx.on('runtime:resolverCacheInvalidated', (detail) => {
			// When ScanService clears its resolver cache, our derived caches may become stale:
			// - workspace entry rewrite (bare → fs entry)
			// - runner host-entry fallbacks and package-name lookups
			this.workspaceEntryResolver.clear()
			this.runner.clearResolutionCaches()
			this.dbg.cache.debug('resolution caches cleared', { detail })
		})
	}

	private formatIdentifier(id: unknown): string {
		if (typeof id === 'string') return id
		if (typeof id === 'function') {
			try {
				return getPluginInfo(id as never).id
			} catch {
				const name = (id as { name?: unknown }).name
				return typeof name === 'string' && name ? name : 'Function'
			}
		}
		return String(id)
	}

	private enrichBatchSummary(summary: HmrBatchSummary, epoch: number): HmrBatchSummary {
		const commit = this.commitByBatchEpoch.get(epoch)
		if (!commit) return summary

		const added = commit.added.map((id) => this.formatIdentifier(id))
		const replaced = commit.replaced.map(({ from, to }) => ({
			from: this.formatIdentifier(from),
			to: this.formatIdentifier(to),
		}))
		const removed = commit.removed.map((id) => this.formatIdentifier(id))
		const failed = commit.failed.map((id) => this.formatIdentifier(id))
		const touched = commit.touched.map((id) => this.formatIdentifier(id))
		const structural = new Set<string>([
			...added,
			...removed,
			...failed,
			...replaced.map((item) => item.from),
			...replaced.map((item) => item.to),
		])
		const restarted = touched.filter((id) => !structural.has(id))

		return {
			...summary,
			lifecycleOk: failed.length === 0,
			commit: { added, replaced, removed, failed, touched, restarted },
		}
	}

	private onBatchSummary(summary: HmrBatchSummary) {
		this.lastBatchSummary = summary
		if (this.batchWaiters.size === 0) return

		const waiters = [...this.batchWaiters]
		for (const w of waiters) {
			if (summary.epoch <= w.afterEpoch) continue
			w.cleanup()
			w.resolve(summary)
		}
	}

	private waitForBatch(options: HmrWaitForBatchOptions = {}): Promise<HmrBatchSummary> {
		const afterEpoch =
			typeof options.afterEpoch === 'number'
				? options.afterEpoch
				: (this.lastBatchSummary?.epoch ?? 0)
		const timeoutMs =
			typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
				? Math.max(0, Math.floor(options.timeoutMs))
				: 30_000

		const current = this.lastBatchSummary
		if (current && current.epoch > afterEpoch) return Promise.resolve(current)

		return new Promise<HmrBatchSummary>((resolveWaiter, rejectWaiter) => {
			let timeout: NodeJS.Timeout | undefined
			let waiter: HmrBatchWaiter | null = null

			const cleanup = () => {
				if (timeout) clearTimeout(timeout)
				timeout = undefined
				if (waiter) this.batchWaiters.delete(waiter)
				waiter = null
				if (typeof options.signal?.removeEventListener === 'function' && onAbort) {
					options.signal.removeEventListener('abort', onAbort)
				}
			}

			const onAbort =
				options.signal && typeof options.signal === 'object'
					? () => {
							cleanup()
							rejectWaiter(Object.assign(new Error('Aborted'), { name: 'AbortError' }))
						}
					: null

			if (options.signal?.aborted) {
				cleanup()
				rejectWaiter(Object.assign(new Error('Aborted'), { name: 'AbortError' }))
				return
			}
			if (onAbort) options.signal.addEventListener('abort', onAbort, { once: true })

			if (timeoutMs > 0) {
				timeout = setTimeout(() => {
					cleanup()
					rejectWaiter(
						Object.assign(new Error(`Timed out waiting for HMR batch (afterEpoch=${afterEpoch})`), {
							name: 'HmrBatchTimeoutError',
							afterEpoch,
						}),
					)
				}, timeoutMs)
			}

			waiter = { afterEpoch, resolve: resolveWaiter, reject: rejectWaiter, cleanup }
			this.batchWaiters.add(waiter)
		})
	}

	private async waitForStable(options: HmrWaitForStableOptions = {}): Promise<HmrBatchSummary> {
		const afterEpoch =
			typeof options.afterEpoch === 'number'
				? options.afterEpoch
				: (this.lastBatchSummary?.epoch ?? 0)
		const timeoutMs =
			typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
				? Math.max(0, Math.floor(options.timeoutMs))
				: 30_000
		const quietMsRaw =
			typeof options.quietMs === 'number' && Number.isFinite(options.quietMs)
				? Math.max(0, Math.floor(options.quietMs))
				: 250

		const hasDeadline = timeoutMs > 0
		const started = hasDeadline ? Date.now() : 0
		let last = await this.waitForBatch({ afterEpoch, timeoutMs, signal: options.signal })
		if (quietMsRaw === 0) return last

		for (;;) {
			const remaining = hasDeadline ? timeoutMs - (Date.now() - started) : Number.POSITIVE_INFINITY
			if (hasDeadline && remaining <= 0) return last

			const probeTimeout = hasDeadline ? Math.min(quietMsRaw, Math.max(0, remaining)) : quietMsRaw
			if (hasDeadline && probeTimeout <= 0) return last
			try {
				const next = await this.waitForBatch({
					afterEpoch: last.epoch,
					timeoutMs: probeTimeout,
					signal: options.signal,
				})
				last = next
			} catch (error) {
				if (error instanceof Error && error.name === 'HmrBatchTimeoutError') {
					return last
				}
				throw error
			}
		}
	}

	private waitForIdle(options: HmrWaitForIdleOptions = {}): Promise<void> {
		if (!this.debouncer) {
			throw new Error('LoaderHmrService not initialized (batching not configured yet)')
		}
		return this.debouncer.waitForIdle(options)
	}

	private async performWarmup() {
		await this.execLock.run(async () => {
			this.timing.clear()
			const endAll = startTimer()
			const endScan = startTimer()
			const scope = await this.ensureStartupScope()
			const scanMs = Math.round(endScan() * 10) / 10
			// Governance: preserve caller-provided entry order.
			// - `entries` order is deliberate (profiles/CLI/host define it)
			// - anchors are appended in sorted order by `ensureStartupScope()`
			const coldFiles = [...scope.entryList]
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
				await prefetchPromise.catch((): undefined => undefined)
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
				hotspots: hotspots.length > 0 ? hotspots : undefined,
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
			const seen = new Set<string>()
			const out: string[] = []

			for (const raw of this.config.entries) {
				if (!raw) continue
				const clean = this.path.toClean(raw)
				if (seen.has(clean)) continue
				seen.add(clean)
				out.push(clean)
			}

			// Always include anchors (even if they would be excluded by filters).
			const sortedAnchors = [...anchorsClean].slice().sort()
			for (const anchor of sortedAnchors) {
				if (seen.has(anchor)) continue
				seen.add(anchor)
				out.push(anchor)
			}

			const rootsAbs = [...this.scanRootsAbs].sort()
			const rootsPretty = rootsAbs.map((root) => this.path.pretty(root))
			const entriesByRoot = Array<number>(rootsAbs.length).fill(0)
			const isUnder = (child: string, root: string) =>
				child === root || child.startsWith(root.endsWith('/') ? root : `${root}/`)

			for (const id of out) {
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
				entries: out.length,
				entryList: out,
				entriesByRoot,
			} as const
		})()
		return await this.startupScope
	}

	private async logOperationalReport(reason: 'startup' | 'executeFiles' | 'warmup') {
		if (!this.shouldLogOperationalReport()) return

		const registryView = this.ctx.loader.api.registry

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
			resolveBareWorkspaceEntry: (specifier) =>
				this.workspaceEntryResolver.resolveBareWorkspaceEntry(specifier),
			resolveLimit: this.config.reportResolveLimit,
			builtinsModuleIds: this.config.builtinsFromDist?.map((b) => b.packageName) ?? [],
			hotspots: hotspots.length > 0 ? hotspots : undefined,
		})

		this.ctx.logger.info('HMR report', report)
	}
}
