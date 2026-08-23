import { availableParallelism, cpus } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { Logger as LogtapeLogger } from '@logtape/logtape'
import {
	type CommitSummary,
	type Context,
	formatPluginNodeReference,
	type PluginConstructor,
	type PluginNodeSlot,
} from '@pluxel/core'
import { requireConfigService, requirePluginService } from '@pluxel/core/internal'
import { dirname, resolve } from 'pathe'
import {
	createServer,
	type DevEnvironment,
	normalizePath,
	type Plugin,
	type ViteDevServer,
} from 'vite'
import {
	PLUXEL_LOADER_HMR_WORKSPACE_CONDITIONS_WITH_SOURCE,
	findNearestPackageRoot,
	isPluginEnabled,
	requireRuntimeStateStore,
	resolveGlobPatterns,
	setPkgrootCacheLimit,
	startTimer,
} from '@pluxel/runtime/internal'
import { roundHmrMs, type HmrReportReason } from '@pluxel/runtime-dev/hmr-log'
import {
	buildLoaderHmrViteConfig,
	LOADER_HMR_BRIDGE_MODULES,
	LOADER_HMR_BRIDGE_PROVIDERS,
	resolveFsAllowList,
} from './config'
import { HmrEnvironment, type HmrPathApi, type HmrToolkit } from './environment'
import { AsyncSerialLock, BatchDebouncer, matchesSpecifierPattern } from './internals'
import { collectHotspots, isLogEnabled, logAttributionReport, TimingTracker } from './logging'
import { buildHmrOperationalReport } from './operational-report'
import {
	HmrBatchProcessor,
	type HmrBatchSummary,
	type HmrExecutionResult,
	type PrefetchTransformResult,
	HmrExecutor,
	prefetchTransforms,
} from './pipeline'
import { HmrRunner, isHardBridgeSpecifier } from './runner'
import { installRequireShims, type RuntimeShimConfig, RuntimeShimRegistry } from './runtime-shims'
import { WorkspaceEntryResolver } from './workspace-entry-resolver'
import { createFetchHmrServerPlugin } from '../vite-fetch-plugin'
import { isRuntimeHttpRouteRequest } from '../runtime-route-request'
import { requireLoaderService, requireScanService } from '../../context-plan'
import type { LoaderService } from '../../loader/LoaderService'
import type { ScanService } from '../../scan/ScanService'

function assertHmrExecutionOk(
	result: HmrExecutionResult | undefined,
	label: string,
): asserts result is HmrExecutionResult | undefined {
	if (!result) return
	const commitResult = result.commitResult
	if (commitResult.ok) return
	const commitError = 'err' in commitResult ? commitResult.err : undefined
	const stage = result.executeError ? 'execute' : result.injectError ? 'inject' : 'commit'
	const message =
		result.executeError ?? result.injectError ?? String(commitError ?? `${stage} failed`)
	throw new Error(`${label} failed during ${stage}: ${message}`, {
		cause: commitError,
	})
}

export interface LoaderHmrConfig {
	/** Host root for relative paths and the stable `app` plugin source space. */
	hostRoot?: string
	/** 业务扫描边界：HMR 只监听这些 roots（用于过滤 watcher 事件、分组报告等）。 */
	roots: string[]
	/** Whether to print Vite HMR server URLs on startup. Defaults to `true`. */
	printUrls?: boolean
	/** Enable operational report output. Defaults to `true`. */
	report?: boolean
	/** Limits workspace-specifier resolution attempts when building the operational report. */
	reportResolveLimit?: number
	/** Vite HMR server port (use `0` to pick a random free port). */
	port?: number
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
	/** 额外允许 Vite HMR server 访问的目录（绝对路径或会基于 cwd 解析的相对路径） */
	fsAllow?: string[]
	/**
	 * Browser entry sources served by the HMR server.
	 *
	 * These are fed into Vite's client-side dep optimizer so browser imports do not fall back to raw
	 * CommonJS `/@fs/.../node_modules/*` files.
	 *
	 * Paths may be absolute or relative to `cwd`.
	 */
	clientEntries?: string[]
	/** Fixed catalog evaluated by the canonical config runner. Internal route wiring only. */
	fixedPlugins?: readonly PluginConstructor[]
	/** Canonical owner derived from the config module path. Internal route wiring only. */
	fixedModuleId: string
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
	private closePromise?: Promise<void>
	private closed = false
	private ownsViteServer = false
	private readonly serverConfigured: Promise<void>
	private serverConfiguredResolve: () => void = () => {}
	private serverConfiguredReject: (error: unknown) => void = () => {}

	private ssrEnv!: DevEnvironment
	private readonly runner = new HmrRunner()
	private readonly loader: LoaderService
	private readonly scanService: ScanService
	private executor!: HmrExecutor
	private batchProcessor!: HmrBatchProcessor

	private readonly hostRoot: string
	private readonly scanRootsAbs: string[]
	private readonly env: HmrEnvironment
	public readonly toolkit: HmrToolkit
	public readonly path: HmrPathApi
	private readonly includeGlobs?: string[]
	private readonly excludeGlobs?: string[]

	private readonly runtimeShims: RuntimeShimRegistry
	private readonly useRequireShims: boolean

	private readonly timing: TimingTracker

	private readonly workspaceEntryResolver: WorkspaceEntryResolver
	private didRegisterFixedPlugins = false
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
	private warmupPromise?: Promise<void>

	private debouncer!: BatchDebouncer
	private readonly watcherDisposers: Array<() => void> = []

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
		...PLUXEL_LOADER_HMR_WORKSPACE_CONDITIONS_WITH_SOURCE,
	])

	/**
	 * Stable, minimal surface for external callers (UI/RPC/tooling).
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
		server?: ViteDevServer,
	) {
		this.hostRoot = normalizePath(resolve(this.config.hostRoot ?? process.cwd()))
		this.loader = requireLoaderService(this.ctx)
		this.scanService = requireScanService(this.ctx)
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
			this.config.roots.map((dir) => normalizePath(resolve(this.hostRoot, dir))),
		)
		this.includeGlobs = resolveGlobPatterns(this.config.include, this.hostRoot)
		this.excludeGlobs = resolveGlobPatterns(this.config.exclude, this.hostRoot)
		this.env = new HmrEnvironment({
			cwd: this.hostRoot,
			scanRootsAbs: this.scanRootsAbs,
			includeGlobs: this.includeGlobs,
			excludeGlobs: this.excludeGlobs,
			pathCacheLimit: this.config.pathCacheLimit,
		})
		this.toolkit = this.env.toolkit
		this.path = this.toolkit.path
		this.workspaceEntryResolver = new WorkspaceEntryResolver(
			this.scanService,
			this.path,
			this.workspaceConditions,
		)

		const runtimeResolved: Record<string, RuntimeShimConfig> = this.config.runtimeShims ?? {}
		this.runtimeShims = new RuntimeShimRegistry({ shims: runtimeResolved })
		this.useRequireShims = this.runtimeShims.hasAny()
		if (this.useRequireShims) installRequireShims((id) => this.runtimeShims.require(id))

		const getDebugChannel = (topic: string): LogtapeLogger =>
			this.ctx.logger.getDebugChannel(topic).logtape

		this.dbg = {
			modules: getDebugChannel('hmr:modules'),
			warmup: getDebugChannel('hmr:warmup'),
			batch: getDebugChannel('hmr:batch'),
			cache: getDebugChannel('hmr:cache'),
			graph: getDebugChannel('hmr:graph'),
			timeEntry: getDebugChannel('hmr:time:entry'),
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
		this.ctx.effects.defer(() => this.close(), {
			tag: 'LoaderHmrService',
			phase: 'shutdown',
		})
		if (server) this.configureServer(server)
	}

	public normalizeId(id: string): string {
		return this.path.toClean(id)
	}

	public get vitePlugin(): Plugin {
		return this.plugin
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
			const executed = await this.executor.runAndLoadAll(filesPath, keepOrder)
			assertHmrExecutionOk(executed, 'HMR executeFiles')
		})
		void this.logOperationalReport('update').catch((error) => {
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
			if (!bestEffort) throw error
			this.ctx.logger.error('warmup failed', { error })
		}
	}

	public start(): Promise<void> {
		if (this.closed) return Promise.reject(new Error('[hmr] LoaderHmrService is closed'))
		if (this.startPromise) return this.startPromise
		const p = this.startImpl()
		this.startPromise = p.catch((error) => {
			this.startPromise = undefined
			throw error
		})
		return this.startPromise
	}

	public close(): Promise<void> {
		if (this.closePromise) return this.closePromise
		this.closed = true
		this.closePromise = (async () => {
			const server = (this as unknown as { vite?: ViteDevServer }).vite
			for (const dispose of this.watcherDisposers.splice(0)) dispose()
			if (server) {
				try {
					await server.watcher.unwatch(this.scanRootsAbs)
				} catch {
					// The server may already have closed its watcher.
				}
			}
			const debouncer = this.debouncer as BatchDebouncer | undefined
			if (typeof debouncer?.close === 'function') await debouncer.close()

			const closedError = Object.assign(new Error('[hmr] LoaderHmrService is closed'), {
				name: 'HmrClosedError',
			})
			for (const waiter of this.batchWaiters) {
				waiter.cleanup()
				waiter.reject(closedError)
			}

			if (server && this.ownsViteServer) await server.close()
			this.startPromise = undefined
		})()
		return this.closePromise
	}

	private async startImpl(): Promise<void> {
		if (this.vite) {
			await this.ensureBaseline()
			await this.loadInitialEntries()
			void this.ctx.logger.info`HMR 服务已启动，只监听：${this.config.roots.join(', ')}`
			void this.logOperationalReport('startup').catch((error) => {
				this.ctx.logger.warn('HMR report failed', { error })
			})
			return
		}

		const serverFsAllow = resolveFsAllowList({
			cwd: this.hostRoot,
			cwdNormalized: this.env.paths.cwdNormalizedPath,
			scanRoots: this.scanRootsAbs,
			configFsAllow: Array.isArray(this.config.fsAllow) ? this.config.fsAllow : undefined,
			hmrPackageRoot,
		})
		const clientEntries = this.config.clientEntries?.map((entry) =>
			normalizePath(resolve(this.hostRoot, entry)),
		)
		const serverConfig = buildLoaderHmrViteConfig({
			// Vite root should point at the HMR package UI, not the host root.
			// Otherwise dep optimization may not crawl the correct entries and will try to update deps at runtime.
			viteRoot: hmrPackageRoot ?? this.hostRoot,
			sourceRoot: this.hostRoot,
			fsAllow: serverFsAllow,
			clientEntries,
			port: this.config.port,
			runnerPlugin: this.plugin,
			httpPlugin: createFetchHmrServerPlugin({
				exclude: [
					/^\/@.+$/,
					/^\/node_modules\/.*/,
					/(\.ts|\.tsx)(\?.*)?$/,
					/^\/favicon\.ico$/,
					/^\/static\/.+/,
					/\?t=\d+$/,
				],
				fetch: (req) => this.ctx.http.fetch(req),
				shouldHandle: (req) => isRuntimeHttpRouteRequest(req, this.ctx),
				handleHotUpdate: ({ server }) => {
					if (this.ctx.http.consumeFullReloadRequest()) {
						server.ws.send({ type: 'full-reload' })
					}
					return []
				},
			}),
		})
		const server = await createServer(serverConfig)
		this.ownsViteServer = true
		try {
			// Parallelize Vite listen and fixed-baseline establishment.
			// so overall startup latency is closer to the slower of the two.
			await Promise.all([
				server.listen(),
				// Fail-fast on bridge/fixed-catalog correctness errors. If this throws,
				// the host process should crash rather than limping along with a broken HMR runtime.
				this.ensureBaseline(),
			])
		} catch (error) {
			await server.close().catch((): undefined => undefined)
			throw error
		}
		await this.loadInitialEntries()

		if (this.config.printUrls !== false) server.printUrls()
		void this.ctx.logger.info`HMR 服务已启动，只监听：${this.config.roots.join(', ')}`
		// Default operational report: info-level, counts only.
		// Best-effort and must never block startup.
		void this.logOperationalReport('startup').catch((error) => {
			this.ctx.logger.warn('HMR report failed', { error })
		})
	}

	private async loadInitialEntries(): Promise<void> {
		if (this.config.entries.length === 0 && this.getAnchorsCleanSnapshot().size === 0) return
		await this.warmup({ bestEffort: false })
	}

	private createRunnerPlugin(): Plugin {
		const plugin: Plugin = {
			name: 'pluxel-runner',
			enforce: 'pre',
			apply: 'serve',

			configureServer: (server) => this.configureServer(server),

			resolveId: async (id, _importer, options) => {
				// Hard isolation: runner-only resolution must never affect the client environment
				// (the HMR server also serves a browser UI + extension compilation).
				if (!options?.ssr) return null

				const shimResolved = this.runtimeShims.resolveId(id)
				if (shimResolved) return shimResolved

				// Never let workspace resolution rewrite bridged singleton modules, otherwise we may end up
				// evaluating a second copy (e.g. workspace TS sources) in the runner.
				if (this.isHardBridgeModule(id) || this.isBridgeModule(id)) {
					return null
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

	private configureServer(server: ViteDevServer): void {
		if (this.closed) throw new Error('[hmr] cannot configure a closed LoaderHmrService')
		if (this.vite) {
			if (this.vite !== server) {
				const error = new Error(
					'[hmr] LoaderHmrService is already configured with a different Vite server',
				)
				this.serverConfiguredReject(error)
				throw error
			}
			return
		}
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
			debug: this.ctx.logger.getDebugChannel('hmr:fetch'),
			cacheLimit: this.config.runnerCacheLimit,
			hostCwd: this.hostRoot,
			bridgeModules: LOADER_HMR_BRIDGE_MODULES,
			bridgeProviders: LOADER_HMR_BRIDGE_PROVIDERS,
			resolveCache: this.scanService.resolverCache,
			workspaceConditions: this.workspaceConditions,
		})
		this.ssrEnv = this.runner.env
	}

	private async bridgeHostModules() {
		await this.runner.bridgeHostModules(LOADER_HMR_BRIDGE_MODULES, this.path, {
			warn: (message, props) => this.ctx.logger.warn(message, props),
		})
		await this.runner.assertBridgedSingletons(LOADER_HMR_BRIDGE_MODULES)
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
				// Keep runtime evaluation fast and quiet by default.
				// Per-batch attribution report is opt-in via `LoaderHmrConfig.attribution`
				// (or `PLUXEL_HMR_ATTRIBUTION`).
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
				// Allow retries if the fixed baseline fails during development.
				this.baseline = undefined
				this.didRegisterFixedPlugins = false
				throw error
			})
		return this.baseline
	}

	private async bootstrapBaseline(): Promise<void> {
		// Ensure on-disk config is loaded before any "enabled in config" decisions happen.
		// (warmup/executeFiles/batches rely on it).
		const configService = requireConfigService(this.ctx)
		if (!configService.isReady) await configService.ready
		const runtimeState = requireRuntimeStateStore(this.ctx)
		if (!runtimeState.isReady) await runtimeState.ready

		// 1) Bridge host modules (singleton identity).
		await this.bridgeHostModules()

		// 2) Establish the fixed baseline so mutable rollback returns to it.
		await this.registerFixedPlugins()
	}

	private async registerFixedPlugins(): Promise<void> {
		if (this.didRegisterFixedPlugins) return
		this.didRegisterFixedPlugins = true
		const plugins = this.config.fixedPlugins ?? []
		if (plugins.length === 0) return

		try {
			const declared = await this.loader.registerFixedPlugins(plugins, {
				moduleId: this.config.fixedModuleId,
			})
			this.ctx.logger.info('Fixed plugin catalog ready', { plugins: declared })
		} catch (error) {
			this.didRegisterFixedPlugins = false
			throw error
		}
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
		server.watcher.add(this.scanRootsAbs)
		const events = ['change', 'add', 'unlink'] as const
		for (const event of events) {
			const listener = (file: string) => this.enqueueFileChange(file)
			server.watcher.on(event, listener)
			this.watcherDisposers.push(() => server.watcher.off(event, listener))
		}
	}

	private enqueueFileChange(file: string) {
		if (this.closed) return false
		const clean = this.path.toClean(file)
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

	private isAnchorClean(clean: string): boolean {
		return this.loader.api.anchors.has(clean)
	}

	private attachCommitTracker() {
		const unsubscribe = requirePluginService(this.ctx).subscribeCommitted(
			(summary: CommitSummary) => {
				const epoch = this.inFlightBatchEpoch
				if (epoch !== null) {
					this.commitByBatchEpoch.set(epoch, summary)
				}
			},
		)
		this.ctx.effects.defer(unsubscribe, { tag: 'LoaderHmrService.commitTracker' })
	}

	private attachResolverCacheInvalidation() {
		const unsubscribe = this.scanService.subscribeResolverInvalidated((detail) => {
			// When ScanService clears its resolver cache, our derived caches may become stale:
			// - workspace entry rewrite (bare → fs entry)
			// - runner host-entry fallbacks and package-name lookups
			this.workspaceEntryResolver.clear()
			this.runner.clearResolutionCaches()
			this.dbg.cache.debug('resolution caches cleared', { detail })
		})
		this.ctx.effects.defer(unsubscribe, {
			tag: 'LoaderHmrService.resolverCacheInvalidation',
		})
	}

	private formatIdentifier(id: PluginNodeSlot): string {
		return formatPluginNodeReference(requirePluginService(this.ctx).nodeAddressOf(id))
	}

	private enrichBatchSummary(summary: HmrBatchSummary, epoch: number): HmrBatchSummary {
		const commit = this.commitByBatchEpoch.get(epoch)
		if (!commit) return summary

		const added = commit.pluginChanges.added.map((id) => this.formatIdentifier(id))
		const replaced = commit.pluginChanges.replaced.map(({ from, to }) => ({
			from: this.formatIdentifier(from),
			to: this.formatIdentifier(to),
		}))
		const removed = commit.pluginChanges.removed.map((id) => this.formatIdentifier(id))
		const availabilityChanged = commit.pluginChanges.availabilityChanged.map((id) =>
			this.formatIdentifier(id),
		)
		const restarted = commit.pluginChanges.restarted.map((id) => this.formatIdentifier(id))
		const autoDisabled: readonly string[] = []
		const pluginChanges = { added, replaced, removed, availabilityChanged, restarted }
		const pluginLifecycleReport = {
			ok: commit.lifecycleReport.ok,
			issues: commit.lifecycleReport.issues.map((issue) =>
				Object.assign(
					{
						plugin: this.formatIdentifier(issue.plugin),
						phase: issue.phase,
						kind: issue.kind,
						message: issue.message,
					},
					issue.error ? { error: issue.error } : {},
					issue.blockedBy ? { blockedBy: this.formatIdentifier(issue.blockedBy) } : {},
				),
			),
		}

		return {
			...summary,
			autoDisabled,
			pluginChanges,
			pluginLifecycleReport,
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
		if (this.closed) {
			return Promise.reject(
				Object.assign(new Error('[hmr] LoaderHmrService is closed'), {
					name: 'HmrClosedError',
				}),
			)
		}
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
			const scanMs = roundHmrMs(endScan())
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
			let prefetchFailed: number | undefined
			let prefetchPromise: Promise<PrefetchTransformResult> | undefined
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
				const prefetch = await prefetchPromise.catch((): undefined => undefined)
				prefetchFailed = prefetch?.failed || undefined
				prefetchMs = roundHmrMs(endPrefetch?.() ?? 0)
			}
			assertHmrExecutionOk(executed, 'HMR warmup')
			const commitMs = executed ? roundHmrMs(executed.commitMs) : null

			const warmupMs = roundHmrMs(endWarmup())
			const totalMs = roundHmrMs(endAll())

			const hotspots = collectHotspots(this.timing, (id) => this.path.pretty(id))

			this.ctx.logger.info('HMR warmup done', {
				files: coldFiles.length,
				scanMs,
				prefetchMs,
				prefetchFailed,
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
		return this.loader.api.anchors.snapshot()
	}

	private isBridgeModule(specifier: string) {
		for (const pattern of LOADER_HMR_BRIDGE_MODULES) {
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

	private async logOperationalReport(reason: HmrReportReason) {
		if (!this.shouldLogOperationalReport()) return

		const registryView = this.loader.api.registry

		const scope = await this.ensureStartupScope()
		const hotspots =
			reason === 'update' ? collectHotspots(this.timing, (id) => this.path.pretty(id)) : []

		const pluginService = requirePluginService(this.ctx)
		const report = await buildHmrOperationalReport({
			reason,
			cwd: this.hostRoot,
			anchors: scope.anchors,
			entries: scope.entries,
			rootsAbs: scope.rootsAbs,
			rootsPretty: scope.rootsPretty,
			entriesByRoot: scope.entriesByRoot,
			registryView,
			isPluginEnabled: (address) =>
				isPluginEnabled(requireRuntimeStateStore(this.ctx).snapshot(), address),
			isRunning: (address) => pluginService.isRunning(address),
			resolveBareWorkspaceEntry: (specifier) =>
				this.workspaceEntryResolver.resolveBareWorkspaceEntry(specifier),
			resolveLimit: this.config.reportResolveLimit,
			hotspots: hotspots.length > 0 ? hotspots : undefined,
		})

		this.ctx.logger.info('HMR report', report)
	}
}
