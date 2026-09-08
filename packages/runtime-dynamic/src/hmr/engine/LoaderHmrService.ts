import { availableParallelism, cpus } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { Logger as LogtapeLogger } from '@logtape/logtape'
import { watch } from 'chokidar'
import {
	type CommitSummary,
	type Context,
	formatPluginNodeReference,
	type PluginDefinitionAddress,
	type PluginConstructor,
	type PluginNodeAddress,
	type PluginNodeSlot,
} from '@pluxel/core'
import { requireConfigService, requirePluginService } from '@pluxel/core/internal'
import { createPluginSourceVitePipeline } from '@pluxel/rolldown/vite'
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
	clonePluginUpdateBatchSnapshot,
	PluginRecentUpdateTracker,
	findNearestPackageRoot,
	requireRuntimeStateStore,
	requireRuntimeHttpService,
	resolveGlobPatterns,
	setPkgrootCacheLimit,
	startTimer,
	type PluginExecutionSnapshot,
	type PluginRecentUpdateSnapshot,
	type PluginUpdateBatchSnapshot,
	type PluginRouteCatalogSnapshot,
	type RuntimeRouteCapabilities,
} from '@pluxel/runtime/internal'
import { roundHmrMs, type HmrReportReason } from '@pluxel/runtime-dev/hmr-log'
import type {
	PreparedWorkbenchArtifacts,
	WorkbenchArtifactCompilations,
} from '@pluxel/runtime-dev/workbench'
import { createViteNodeElysiaApplicationCarrier } from '@pluxel/runtime-dev/vite'
import {
	buildLoaderHmrViteConfig,
	LOADER_HMR_BRIDGE_MODULES,
	LOADER_HMR_OPTIONAL_BRIDGE_MODULES,
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
import { DEFAULT_VITE_WATCH_IGNORED, VITE_WATCH_USE_POLLING } from '../vite-watch'
import { requireLoaderService, requireScanService } from '../../context-plan'
import type { LoaderService } from '../../loader/LoaderService'
import type { ScanService } from '../../scan/ScanService'

type OwnedElysiaApplicationCarrier = ReturnType<typeof createViteNodeElysiaApplicationCarrier>

export type LoaderHmrDefinitionSource = Readonly<{
	classifyDefinitionArtifact(
		definition: PluginDefinitionAddress,
		activeModules?: Iterable<string>,
	): 'source-module' | 'built-module' | 'unreported'
	beginArtifactGeneration?(): LoaderHmrArtifactGeneration
	fixedModules?: () => Iterable<string>
}>

type LoaderHmrArtifactGeneration = Readonly<{
	run<T>(operation: () => T): T
	commit(): void
	rollback(): void
}>

const consolePreparationByService = new WeakMap<LoaderHmrService, () => Promise<void>>()

/** @internal Captures pending watcher batches and the current finite execution boundary. */
export function prepareLoaderHmrConsoleUpdate(service: LoaderHmrService): Promise<void> {
	const prepare = consolePreparationByService.get(service)
	if (!prepare) throw new Error('[hmr] console preparation is unavailable')
	return prepare()
}

const definitionSourceByService = new WeakMap<LoaderHmrService, LoaderHmrDefinitionSource>()
const recentUpdatesByService = new WeakMap<LoaderHmrService, PluginRecentUpdateTracker>()
const SUPPLEMENTAL_WATCH_IGNORED = [
	'**/node_modules/**',
	'**/.git/**',
	...DEFAULT_VITE_WATCH_IGNORED,
]

/** @internal Connects the exact semantic collector that transforms this HMR route. */
export function configureLoaderHmrDefinitionSource(
	service: LoaderHmrService,
	source: LoaderHmrDefinitionSource,
): void {
	definitionSourceByService.set(service, source)
}

/** @internal Reads the bounded, path-free diagnostic projected by the HMR route. */
export function readLoaderHmrRecentUpdate(
	service: LoaderHmrService,
	address: PluginNodeAddress,
): PluginRecentUpdateSnapshot | null {
	return recentUpdatesByService.get(service)?.resolveRecentUpdate(address) ?? null
}

/** @internal The route owns one update feed, including failures with no committed Plugin node. */
export function createLoaderHmrUpdateReader(
	service: LoaderHmrService,
): NonNullable<RuntimeRouteCapabilities['recentUpdate']> {
	return Object.freeze({
		resolveRecentUpdate: (address: PluginNodeAddress) =>
			readLoaderHmrRecentUpdate(service, address),
		latestUpdate: () => recentUpdatesByService.get(service)?.latestUpdate() ?? null,
		subscribeUpdates: (observer: Parameters<PluginRecentUpdateTracker['subscribeUpdates']>[0]) =>
			recentUpdatesByService.get(service)?.subscribeUpdates(observer) ?? (() => {}),
	})
}

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

function pluginExecutionEqual(
	left: PluginExecutionSnapshot | undefined,
	right: PluginExecutionSnapshot | undefined,
): boolean {
	if (left === right) return true
	if (!left || !right) return false
	if (left.kind !== right.kind || left.artifact.kind !== right.artifact.kind) return false
	if (left.update.kind !== right.update.kind) return false
	if (left.update.kind !== 'definition-hmr') return true
	return right.update.kind === 'definition-hmr' && left.update.scope === right.update.scope
}

function runInArtifactGeneration<T>(
	generation: LoaderHmrArtifactGeneration | undefined,
	operation: () => T,
): T {
	return generation ? generation.run(operation) : operation()
}

function createHmrClosedError(): Error {
	return Object.assign(new Error('[hmr] LoaderHmrService is closed'), {
		name: 'HmrClosedError',
	})
}

function hmrFailureMessage(error: unknown): string {
	if (error instanceof Error) return error.message || error.name
	return String(error)
}

function isGeneratedStateRoot(path: string): boolean {
	return normalizePath(path).split('/').includes('.pluxel')
}

function generatedStateAnchor(path: string): string | null {
	const segments = normalizePath(path).split('/')
	const generatedSegment = segments.indexOf('.pluxel')
	return generatedSegment < 0 ? null : segments.slice(0, generatedSegment + 1).join('/')
}

function pathAtOrWithin(path: string, root: string): boolean {
	return path === root || path.startsWith(`${root}/`)
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

type WorkbenchArtifactState = {
	prepare?: (input: WorkbenchArtifactCompilations) => Promise<PreparedWorkbenchArtifacts>
	source?: Readonly<{
		compilations(): Promise<WorkbenchArtifactCompilations>
	}>
	contentSources?: ReadonlySet<string>
}

const workbenchArtifactStates = new WeakMap<LoaderHmrService, WorkbenchArtifactState>()

/** @internal Connects the route-owned compiler without exposing it on LoaderHmrService. */
export function attachLoaderHmrWorkbenchArtifactPreparer(
	service: LoaderHmrService,
	prepare: (input: WorkbenchArtifactCompilations) => Promise<PreparedWorkbenchArtifacts>,
): void {
	const state = workbenchArtifactStates.get(service) ?? {}
	if (state.prepare && state.prepare !== prepare) {
		throw new Error('[hmr] Workbench artifact preparer is already attached')
	}
	state.prepare = prepare
	workbenchArtifactStates.set(service, state)
}

/** @internal Installs the sole semantic plan source used by initial load and every HMR commit. */
export function configureLoaderHmrWorkbenchArtifactSource(
	service: LoaderHmrService,
	source: Readonly<{
		compilations(): Promise<WorkbenchArtifactCompilations>
	}>,
): void {
	const state = workbenchArtifactStates.get(service) ?? {}
	if (state.source && state.source !== source) {
		throw new Error('[hmr] Workbench artifact source is already configured')
	}
	state.source = source
	workbenchArtifactStates.set(service, state)
}

/** @internal Refreshes the complete artifact snapshot and records its exact non-module sources. */
export async function refreshLoaderHmrWorkbenchArtifacts(service: LoaderHmrService): Promise<void> {
	const prepared = await prepareLoaderHmrWorkbenchArtifacts(service)
	prepared?.commit()
}

async function prepareLoaderHmrWorkbenchArtifacts(
	service: LoaderHmrService,
): Promise<PreparedWorkbenchArtifacts | undefined> {
	const state = workbenchArtifactStates.get(service)
	if (!state?.prepare || !state.source) return undefined
	const compilations = await state.source.compilations()
	const contentSources = new Set(
		compilations.content.flatMap((content) =>
			content.sources.map((source) => service.normalizeId(source)),
		),
	)
	const prepared = await state.prepare(compilations)
	return Object.freeze({
		commit: () => {
			const commits = prepared.commit()
			state.contentSources = contentSources
			return commits
		},
		rollback: () => prepared.rollback(),
	})
}

function hasLoaderHmrWorkbenchArtifactPipeline(service: LoaderHmrService): boolean {
	const state = workbenchArtifactStates.get(service)
	return Boolean(state?.prepare && state.source)
}

/** @internal Exact source predicate used before the TypeScript/module-graph HMR filters. */
export function isLoaderHmrWorkbenchContentSource(
	service: LoaderHmrService,
	file: string,
): boolean {
	return (
		workbenchArtifactStates.get(service)?.contentSources?.has(service.normalizeId(file)) ?? false
	)
}

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
	private readonly watcherDisposers: Array<() => void | Promise<void>> = []
	private supplementalWatcherReady: Promise<void> = Promise.resolve()
	private supplementalWatcherSetupError: unknown
	private ownedApplicationCarrier?: OwnedElysiaApplicationCarrier
	private detachOwnedApplicationCarrier?: () => void

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
	private readonly disposeExecutionResolver: () => void

	constructor(
		public ctx: Context,
		private readonly config: LoaderHmrConfig,
		server?: ViteDevServer,
	) {
		this.hostRoot = normalizePath(resolve(this.config.hostRoot ?? process.cwd()))
		this.loader = requireLoaderService(this.ctx)
		this.scanService = requireScanService(this.ctx)
		recentUpdatesByService.set(this, new PluginRecentUpdateTracker())
		this.disposeExecutionResolver = this.loader.configureExecutionResolver((definition, moduleId) =>
			this.resolvePluginExecution(definition, moduleId),
		)
		this.ctx.effects.defer(this.disposeExecutionResolver, {
			tag: 'LoaderHmrService.executionProvenance',
			phase: 'shutdown',
		})
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

		consolePreparationByService.set(this, () => {
			this.assertOpen()
			// Capture before yielding: subsequent watcher events do not prolong this barrier.
			const batches = this.debouncer.flushObserved()
			const executions = this.execLock.run(async () => {})
			return Promise.all([batches, executions]).then(() => this.assertOpen())
		})

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
		this.assertOpen()
		if (!this.executor) {
			throw new Error('LoaderHmrService not initialized (Vite server not configured yet)')
		}
		await this.execLock.run(async () => {
			// A call admitted before close() may have queued behind another execution. Re-check when
			// it actually owns the execution lane so shutdown cannot dispose resources underneath it.
			this.assertOpen()
			await this.ensureBaseline()
			this.timing.clear()
			const catalogBefore = this.loaderCatalogSnapshot()
			const generation = definitionSourceByService.get(this)?.beginArtifactGeneration?.()
			try {
				const executed = await runInArtifactGeneration(generation, () =>
					this.executor.runAndLoadAll(filesPath, keepOrder),
				)
				const catalogApplied = this.loaderCatalogSnapshot() !== catalogBefore
				if (!executed || (!executed.commitResult.ok && !catalogApplied)) generation?.rollback()
				else generation?.commit()
				assertHmrExecutionOk(executed, 'HMR executeFiles')
			} catch (error) {
				if (this.loaderCatalogSnapshot() !== catalogBefore) generation?.commit()
				else generation?.rollback()
				throw error
			}
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
		this.assertOpen()
		const bestEffort = opts?.bestEffort ?? true
		if (!this.executor) {
			throw new Error('LoaderHmrService not initialized (Vite server not configured yet)')
		}
		const p = (this.warmupPromise ??= this.performWarmup())
		try {
			await p
		} catch (error) {
			// Allow retry after failure.
			this.warmupPromise = undefined
			if (this.closed || (error instanceof Error && error.name === 'HmrClosedError')) throw error
			if (!bestEffort) throw error
			this.ctx.logger.error('warmup failed', { error })
		}
	}

	public start(): Promise<void> {
		if (this.closed) return Promise.reject(createHmrClosedError())
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
			const closeErrors: unknown[] = []
			// Stop every watcher admission path synchronously before awaiting external resources.
			const watcherCloseTasks: Promise<void>[] = []
			for (const dispose of this.watcherDisposers.splice(0)) {
				try {
					watcherCloseTasks.push(Promise.resolve(dispose()))
				} catch (error) {
					closeErrors.push(error)
				}
			}
			// Startup owns setup work that can run outside the execution lane. Let it observe `closed`
			// and settle before resolving the final server/carrier handles to dispose.
			await this.startPromise?.catch((): undefined => undefined)
			const watcherCloseResults = await Promise.allSettled(watcherCloseTasks)
			for (const result of watcherCloseResults) {
				if (result.status === 'rejected') closeErrors.push(result.reason)
			}
			const server = (this as unknown as { vite?: ViteDevServer }).vite
			if (server) {
				try {
					await server.watcher.unwatch(
						this.scanRootsAbs.filter((root) => !isGeneratedStateRoot(root)),
					)
				} catch {
					// The server may already have closed its watcher.
				}
			}
			const debouncer = this.debouncer as BatchDebouncer | undefined
			try {
				if (typeof debouncer?.close === 'function') await debouncer.close()
			} catch (error) {
				closeErrors.push(error)
			}
			try {
				// Direct executeFiles/warmup calls share this lane but are not owned by the debouncer.
				// The no-op runs only after active work has finished and queued work has re-checked closed.
				await this.execLock.run(async () => {})
			} catch (error) {
				closeErrors.push(error)
			}
			this.disposeExecutionResolver()
			definitionSourceByService.delete(this)
			recentUpdatesByService.delete(this)

			const closedError = createHmrClosedError()
			for (const waiter of this.batchWaiters) {
				waiter.cleanup()
				waiter.reject(closedError)
			}

			const applicationCarrier = this.ownedApplicationCarrier
			applicationCarrier?.stopAccepting()
			try {
				if (server && this.ownsViteServer) await server.close()
			} catch (error) {
				closeErrors.push(error)
			}
			this.detachOwnedApplicationCarrier?.()
			this.detachOwnedApplicationCarrier = undefined
			this.ownedApplicationCarrier = undefined
			try {
				await applicationCarrier?.close()
			} catch (error) {
				closeErrors.push(error)
			}
			this.startPromise = undefined
			if (closeErrors.length === 1) throw closeErrors[0]
			if (closeErrors.length > 1) {
				throw new AggregateError(closeErrors, '[hmr] LoaderHmrService shutdown failed')
			}
		})()
		return this.closePromise
	}

	private assertOpen(): void {
		if (this.closed) throw createHmrClosedError()
	}

	private async startImpl(): Promise<void> {
		if (this.vite) {
			await this.waitForWatchersReady()
			await refreshLoaderHmrWorkbenchArtifacts(this)
			this.assertOpen()
			await this.ensureBaseline()
			this.assertOpen()
			await this.loadInitialEntries()
			this.assertOpen()
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
		const sourcePipeline = createPluginSourceVitePipeline({
			root: this.hostRoot,
			name: 'pluxel:dynamic-runtime-source',
		})
		configureLoaderHmrDefinitionSource(this, sourcePipeline.semantics)
		configureLoaderHmrWorkbenchArtifactSource(this, {
			compilations: async () => {
				sourcePipeline.semantics.invalidateWorkbench()
				const [producers, content] = await Promise.all([
					sourcePipeline.semantics.workbenchCompilations(),
					sourcePipeline.semantics.workbenchContentCompilations(),
				])
				return { producers, content }
			},
		})
		let applicationCarrier: OwnedElysiaApplicationCarrier | undefined
		const serverConfig = buildLoaderHmrViteConfig({
			// Vite root should point at the HMR package UI, not the host root.
			// Otherwise dep optimization may not crawl the correct entries and will try to update deps at runtime.
			viteRoot: hmrPackageRoot ?? this.hostRoot,
			sourceRoot: this.hostRoot,
			fsAllow: serverFsAllow,
			clientEntries,
			port: this.config.port,
			sourcePlugins: sourcePipeline.plugins,
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
				fetch: (req) => requireRuntimeHttpService(this.ctx).fetch(req),
				shouldHandle: (req) => isRuntimeHttpRouteRequest(req, this.ctx),
				businessWebSocket: {
					matches: (request) => applicationCarrier?.matchesUpgrade(request) ?? false,
					handle: (request, socket, head) =>
						applicationCarrier?.handleUpgrade(request, socket, head),
				},
				handleHotUpdate: ({ server }) => {
					if (requireRuntimeHttpService(this.ctx).consumeFullReloadRequest()) {
						server.ws.send({ type: 'full-reload' })
					}
					return []
				},
			}),
		})
		const server = await createServer(serverConfig)
		this.ownsViteServer = true
		applicationCarrier = createViteNodeElysiaApplicationCarrier(server, {
			fetch: (request) => requireRuntimeHttpService(this.ctx).fetch(request),
			matches: (request) => requireRuntimeHttpService(this.ctx).matchesWebSocketRoute(request),
		})
		this.ownedApplicationCarrier = applicationCarrier
		this.detachOwnedApplicationCarrier = requireRuntimeHttpService(
			this.ctx,
		).attachApplicationCarrier(applicationCarrier)
		try {
			// Parallelize Vite listen and fixed-baseline establishment.
			// so overall startup latency is closer to the slower of the two.
			await server.listen()
			await this.waitForWatchersReady()
			this.assertOpen()
			await refreshLoaderHmrWorkbenchArtifacts(this)
			this.assertOpen()
			// Fail-fast on bridge/fixed-catalog correctness errors. If this throws,
			// the host process should crash rather than limping along with a broken HMR runtime.
			await this.ensureBaseline()
			this.assertOpen()
		} catch (error) {
			applicationCarrier.stopAccepting()
			await server.close().catch((): undefined => undefined)
			this.detachOwnedApplicationCarrier?.()
			this.detachOwnedApplicationCarrier = undefined
			this.ownedApplicationCarrier = undefined
			await applicationCarrier.close().catch((): undefined => undefined)
			throw error
		}
		await this.loadInitialEntries()
		this.assertOpen()

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

	private resolvePluginExecution(
		definition: PluginDefinitionAddress,
		moduleId: string,
	): PluginExecutionSnapshot {
		const fixed = moduleId.startsWith('pluxel:fixed:')
		const source = definitionSourceByService.get(this)
		let artifact: 'source-module' | 'built-module' | 'unreported' = 'unreported'
		if (source) {
			const activeModules = fixed ? source.fixedModules?.() : this.activeModuleFiles(moduleId)
			if (activeModules !== undefined) {
				artifact = source.classifyDefinitionArtifact(definition, activeModules)
			}
		}

		if (fixed) {
			return Object.freeze({
				kind: 'dynamic-fixed',
				artifact: Object.freeze({ kind: artifact }),
				update: Object.freeze({ kind: 'host-reload' }),
			})
		}
		if (artifact === 'source-module') {
			return Object.freeze({
				kind: 'dynamic-entry',
				artifact: Object.freeze({ kind: artifact }),
				update: Object.freeze({ kind: 'definition-hmr', scope: 'source-graph' }),
			})
		}
		return Object.freeze({
			kind: 'dynamic-entry',
			artifact: Object.freeze({ kind: artifact }),
			update: Object.freeze({ kind: 'definition-hmr', scope: 'entry-only' }),
		})
	}

	private activeModuleFiles(moduleId: string): Iterable<string> | undefined {
		type ModuleLike = { id?: string; file?: string | null; importedModules?: Set<ModuleLike> }
		const graph = this.ssrEnv?.moduleGraph
		if (!graph) return undefined
		const queue: ModuleLike[] = []
		for (const variant of this.path.variants(moduleId)) {
			const direct = graph.getModuleById(variant)
			if (direct) queue.push(direct as ModuleLike)
			for (const entry of graph.getModulesByFile(variant) ?? []) queue.push(entry as ModuleLike)
		}
		if (queue.length === 0) return undefined
		const files = new Set<string>()
		const seen = new Set<ModuleLike>()
		while (queue.length > 0) {
			const current = queue.shift()!
			if (seen.has(current)) continue
			seen.add(current)
			if (current.id) files.add(current.id)
			if (current.file) files.add(current.file)
			for (const imported of current.importedModules ?? []) queue.push(imported)
		}
		return files
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
			optionalBridgeModules: LOADER_HMR_OPTIONAL_BRIDGE_MODULES,
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
			beforeCommit: () => prepareLoaderHmrWorkbenchArtifacts(this),
			hasBeforeCommit: () => hasLoaderHmrWorkbenchArtifactPipeline(this),
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
				const enriched = await this.execLock.run(async () => {
					const catalogBefore = this.loaderCatalogSnapshot()
					const generation = definitionSourceByService.get(this)?.beginArtifactGeneration?.()
					const startedAt = performance.now()
					let generationSettled = false
					let execution: HmrExecutionResult | undefined
					const settleGeneration = (commit: boolean): void => {
						if (generationSettled) return
						generationSettled = true
						if (commit) generation?.commit()
						else generation?.rollback()
					}
					try {
						const summary = await runInArtifactGeneration(generation, () =>
							this.batchProcessor.process(files, epoch, (result) => {
								execution = result
							}),
						)
						if (!summary) {
							settleGeneration(false)
							return undefined
						}
						const catalogAfter = this.loaderCatalogSnapshot()
						const catalogApplied = this.didExecutionApplyCatalog(
							execution,
							catalogBefore,
							catalogAfter,
						)
						if (summary.ok || catalogApplied) {
							settleGeneration(true)
						} else {
							settleGeneration(false)
						}
						const exactCommit = execution?.commitSummary
						const result = this.enrichBatchSummary(summary, exactCommit)
						this.recordRecentUpdates(result, catalogBefore, exactCommit, catalogApplied)
						return result
					} catch (error) {
						const catalogAfter = this.loaderCatalogSnapshot()
						const catalogApplied = this.didExecutionApplyCatalog(
							execution,
							catalogBefore,
							catalogAfter,
						)
						settleGeneration(catalogApplied)
						const durationMs = roundHmrMs(performance.now() - startedAt)
						const exactCommit = execution?.commitSummary
						let result = this.createFailedBatchSummary({
							files,
							epoch,
							durationMs,
							error,
							execution,
						})
						try {
							result = this.enrichBatchSummary(result, exactCommit)
							if (catalogApplied) {
								this.recordPostCommitFailure({
									files,
									epoch,
									durationMs,
									catalogBefore,
									catalogAfter,
									commit: exactCommit,
									error,
								})
							} else {
								this.recordRecentUpdates(result, catalogBefore, exactCommit, false)
							}
						} catch (reportError) {
							this.ctx.logger.warn('failed to project HMR batch failure', { reportError })
						}
						this.ctx.logger.error('batch processing failed', {
							epoch,
							catalogApplied,
							error,
						})
						return result
					}
				})
				if (enriched) this.onBatchSummary(enriched)
			},
			BATCH_DEBOUNCE_MS,
			BATCH_MAX_WAIT_MS,
			BATCH_MAX_FILES,
			(error) => this.ctx.logger.error('batch flush failed', { error }),
		)
	}

	private registerWatchers(server: ViteDevServer) {
		const viteRoots = this.scanRootsAbs.filter((root) => !isGeneratedStateRoot(root))
		if (viteRoots.length > 0) server.watcher.add(viteRoots)
		const events = ['change', 'add', 'unlink'] as const
		for (const event of events) {
			const listener = (file: string) => {
				// `.pluxel` has one watcher owner even if an outer Vite configuration accidentally
				// surfaces a generated event. This also collapses Vite + supplemental rename duplicates.
				if (isGeneratedStateRoot(file)) return
				this.enqueueFileChange(file)
			}
			server.watcher.on(event, listener)
			this.watcherDisposers.push(() => {
				server.watcher.off(event, listener)
			})
		}

		// Generated state remains globally ignored by Vite. A source producer may nevertheless declare
		// an exact `.pluxel` entry root (for example managed package wrappers), so fill only that explicit
		// hole with a route-owned watcher. The normal path filter remains the final admission boundary.
		const generatedRoots = this.scanRootsAbs.filter(isGeneratedStateRoot)
		if (generatedRoots.length === 0 || server.config.server.watch === null) return
		const generatedAnchors = unique(
			generatedRoots.flatMap((root) => {
				const anchor = generatedStateAnchor(root)
				return anchor ? [anchor] : []
			}),
		)

		const watcher = watch(generatedAnchors, {
			ignoreInitial: true,
			atomic: BATCH_MAX_WAIT_MS,
			awaitWriteFinish: {
				stabilityThreshold: BATCH_MAX_WAIT_MS,
				pollInterval: 20,
			},
			ignored: [
				...SUPPLEMENTAL_WATCH_IGNORED,
				(path: string) => {
					const clean = normalizePath(path)
					return !generatedRoots.some(
						(root) => pathAtOrWithin(clean, root) || pathAtOrWithin(root, clean),
					)
				},
			],
			usePolling: VITE_WATCH_USE_POLLING,
		})
		let ready = false
		let settleReady = (): void => {}
		this.supplementalWatcherReady = new Promise<void>((resolveReady) => {
			settleReady = resolveReady
		})
		const onReady = (): void => {
			ready = true
			settleReady()
		}
		const onError = (error: unknown): void => {
			if (!ready) {
				this.supplementalWatcherSetupError ??= error
				settleReady()
				return
			}
			this.ctx.logger.error('supplemental generated-source watcher failed', { error })
		}
		const listeners = events.map((event) => {
			const listener = (file: string): void => {
				this.enqueueFileChange(file)
			}
			watcher.on(event, listener)
			return { event, listener }
		})
		watcher.once('ready', onReady)
		watcher.on('error', onError)
		this.watcherDisposers.push(async () => {
			for (const { event, listener } of listeners) watcher.off(event, listener)
			watcher.off('ready', onReady)
			// Unblock startup before awaiting close; it will observe `closed` at the next assertion.
			settleReady()
			try {
				await watcher.close()
			} finally {
				// Keep the error listener installed while close is still settling so an asynchronous watcher
				// failure cannot become an unhandled EventEmitter `error`.
				watcher.off('error', onError)
			}
		})
	}

	private async waitForWatchersReady(): Promise<void> {
		await this.supplementalWatcherReady
		this.assertOpen()
		if (this.supplementalWatcherSetupError !== undefined) {
			throw new Error('[hmr] failed to initialize generated-source watcher', {
				cause: this.supplementalWatcherSetupError,
			})
		}
	}

	private enqueueFileChange(file: string) {
		if (this.closed) return false
		const clean = this.path.toClean(file)
		if (isLoaderHmrWorkbenchContentSource(this, clean)) {
			// Admission is synchronous: execLock reserves this work before close() can append its
			// drain barrier. An admitted refresh may publish, but it never reloads the browser after close.
			void this.execLock.run(async () => {
				const updates = recentUpdatesByService.get(this)
				const startedAt = performance.now()
				updates?.beginUpdate(clean.split('/').at(-1) ?? null)
				updates?.updatePhase('artifacts')
				let published = false
				let failure: NonNullable<PluginUpdateBatchSnapshot['error']> | null = null
				try {
					await refreshLoaderHmrWorkbenchArtifacts(this)
					published = true
					if (!this.closed) this.forwardWorkbenchFullReload()
					updates?.record({
						definitionKeys: [],
						batch: {
							scope: 'application',
							outcome: 'applied',
							phase: null,
							durationMs: roundHmrMs(performance.now() - startedAt),
						},
					})
				} catch (error) {
					failure = this.portableUpdateError(error)
					updates?.record({
						definitionKeys: [],
						batch: {
							scope: 'application',
							...(published
								? { outcome: 'applied-with-issues' as const, phase: 'commit' as const }
								: { outcome: 'retained-previous' as const, phase: 'artifacts' as const }),
							durationMs: roundHmrMs(performance.now() - startedAt),
							error: failure,
						},
					})
					this.ctx.logger.error('failed to rebuild Workbench Content artifact', {
						file: clean,
						error,
					})
				} finally {
					updates?.finishUpdate(failure)
				}
			})
			return true
		}
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

	private forwardWorkbenchFullReload(): void {
		if (requireRuntimeHttpService(this.ctx).consumeFullReloadRequest()) {
			this.vite.ws.send({ type: 'full-reload' })
		}
	}

	private isAnchorClean(clean: string): boolean {
		return this.loader.api.anchors.has(clean)
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

	private enrichBatchSummary(
		summary: HmrBatchSummary,
		commit: CommitSummary | undefined,
	): HmrBatchSummary {
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
			pluginChanges,
			pluginLifecycleReport,
		}
	}

	private createFailedBatchSummary(input: {
		files: readonly string[]
		epoch: number
		durationMs: number
		error: unknown
		execution: HmrExecutionResult | undefined
	}): HmrBatchSummary {
		const execution = input.execution
		return {
			epoch: input.epoch,
			changed: [...input.files],
			targets: [],
			affectedModules: execution?.affectedModules ?? [],
			syncedModules: execution?.syncedModules ?? [],
			desiredButStopped: [],
			affected: 0,
			fallbackRoots: 0,
			invalidated: { vite: 0, runner: 0 },
			activeServices: 0,
			plugins: { loaded: 0, desired: 0, running: 0 },
			commitMs: execution ? roundHmrMs(execution.commitMs) : null,
			batchMs: input.durationMs,
			ok: false,
			...(execution?.executeError
				? { executeError: execution.executeError }
				: execution?.injectError
					? { injectError: execution.injectError }
					: { commitError: hmrFailureMessage(input.error) }),
			prefetchFailed: 0,
		}
	}

	private didExecutionApplyCatalog(
		execution: HmrExecutionResult | undefined,
		catalogBefore: PluginRouteCatalogSnapshot,
		catalogAfter: PluginRouteCatalogSnapshot,
	): boolean {
		if (!execution) return false
		// A resolved commit is authoritative for this request. The identity comparison is retained
		// only for the rare case where core throws after publishing the graph at its PONR.
		return execution.commitResult.ok || catalogAfter !== catalogBefore
	}

	private recordRecentUpdates(
		summary: HmrBatchSummary,
		catalogBefore: PluginRouteCatalogSnapshot,
		commit: CommitSummary | undefined,
		catalogApplied = this.loaderCatalogSnapshot() !== catalogBefore,
	): void {
		const definitionKeys = new Set<string>()
		const relatedModules = [
			...summary.changed,
			...summary.targets,
			...summary.affectedModules,
			...summary.syncedModules,
		]
		this.collectCatalogDefinitionKeys(catalogBefore, relatedModules, definitionKeys)
		this.collectCatalogDefinitionKeys(this.loaderCatalogSnapshot(), relatedModules, definitionKeys)
		const update: PluginUpdateBatchSnapshot = clonePluginUpdateBatchSnapshot(
			!summary.ok
				? catalogApplied
					? {
							scope: 'definitions',
							sequence: summary.epoch,
							outcome: 'applied-with-issues',
							phase: 'commit',
							durationMs: summary.batchMs,
						}
					: {
							scope: 'definitions',
							sequence: summary.epoch,
							outcome: 'retained-previous',
							phase: summary.executeError ? 'evaluate' : summary.injectError ? 'inject' : 'commit',
							durationMs: summary.batchMs,
						}
				: commit && !commit.lifecycleReport.ok
					? {
							scope: 'definitions',
							sequence: summary.epoch,
							outcome: 'applied-with-issues',
							phase: 'lifecycle',
							durationMs: summary.batchMs,
						}
					: {
							scope: 'definitions',
							sequence: summary.epoch,
							outcome: 'applied',
							phase: null,
							durationMs: summary.batchMs,
						},
		)

		const failure = summary.executeError ?? summary.injectError ?? summary.commitError
		this.storeRecentUpdates(
			definitionKeys,
			failure ? { ...update, error: this.portableUpdateError(failure) } : update,
			commit,
		)
	}

	private recordPostCommitFailure(input: {
		error: unknown
		files: readonly string[]
		epoch: number
		durationMs: number
		catalogBefore: PluginRouteCatalogSnapshot
		catalogAfter: PluginRouteCatalogSnapshot
		commit: CommitSummary | undefined
	}): void {
		const definitionKeys = new Set<string>()
		this.collectCatalogDefinitionKeys(input.catalogBefore, input.files, definitionKeys)
		this.collectCatalogDefinitionKeys(input.catalogAfter, input.files, definitionKeys)
		this.collectCatalogDeltaDefinitionKeys(input.catalogBefore, input.catalogAfter, definitionKeys)
		this.storeRecentUpdates(
			definitionKeys,
			clonePluginUpdateBatchSnapshot({
				scope: 'definitions',
				sequence: input.epoch,
				outcome: 'applied-with-issues',
				phase: 'commit',
				durationMs: input.durationMs,
				error: this.portableUpdateError(input.error),
			}),
			input.commit,
		)
	}

	private portableUpdateError(error: unknown): NonNullable<PluginUpdateBatchSnapshot['error']> {
		const root = normalizePath(this.config.hostRoot ?? this.vite?.config.root ?? process.cwd())
		const message = hmrFailureMessage(error)
			.replaceAll('\\', '/')
			.replaceAll(/\bfile:(?:\/\/)?/g, '')
			.replaceAll('/@fs/', '/')
			.replaceAll(root + '/', '')
			.replaceAll(
				/(?:[A-Za-z]:)?\/(?:[^\s'"()<>:]+\/)+[^\s'"()<>:]*/g,
				(path) => path.split('/').at(-1) ?? '[source]',
			)
			.slice(0, 4096)
		return { message, file: null, importChain: [] }
	}

	private collectCatalogDeltaDefinitionKeys(
		before: PluginRouteCatalogSnapshot,
		after: PluginRouteCatalogSnapshot,
		output: Set<string>,
	): void {
		for (const entry of before.entries) {
			const next = after.byDefinition.get(entry.indexKey)
			if (
				!next ||
				next.candidate !== entry.candidate ||
				next.provenance.moduleId !== entry.provenance.moduleId ||
				!pluginExecutionEqual(next.provenance.execution, entry.provenance.execution)
			) {
				output.add(entry.indexKey)
			}
		}
		for (const entry of after.entries) {
			if (!before.byDefinition.has(entry.indexKey)) output.add(entry.indexKey)
		}
	}

	private storeRecentUpdates(
		definitionKeys: ReadonlySet<string>,
		batch: PluginUpdateBatchSnapshot,
		commit?: CommitSummary,
	): void {
		// Content refreshes share this feed but not the module debouncer epoch.
		// Let its single tracker allocate monotonic identities across both update paths.
		const { sequence: _moduleEpoch, ...update } = batch
		recentUpdatesByService.get(this)?.record({
			definitionKeys,
			batch: update,
			...(commit
				? {
						lifecycle: {
							commit,
							addressOf: (slot: PluginNodeSlot) =>
								requirePluginService(this.ctx).nodeAddressOf(slot),
						},
					}
				: {}),
		})
	}

	private collectCatalogDefinitionKeys(
		catalog: PluginRouteCatalogSnapshot,
		moduleIds: readonly string[],
		output: Set<string>,
	): void {
		const related = new Set<string>()
		for (const moduleId of moduleIds) {
			for (const variant of this.path.variants(moduleId)) related.add(this.path.toClean(variant))
		}
		for (const entry of catalog.entries) {
			const moduleId = entry.provenance.moduleId
			if (!moduleId) continue
			if (this.path.variants(moduleId).some((variant) => related.has(this.path.toClean(variant)))) {
				output.add(entry.indexKey)
			}
		}
	}

	private loaderCatalogSnapshot(): PluginRouteCatalogSnapshot {
		return this.loader.api.registry.catalogSnapshot()
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
			this.assertOpen()
			await this.ensureBaseline()
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
			const catalogBefore = this.loaderCatalogSnapshot()
			const generation = definitionSourceByService.get(this)?.beginArtifactGeneration?.()
			let prefetchMs: number | undefined
			let prefetchFailed: number | undefined
			let prefetchPromise: Promise<PrefetchTransformResult> | undefined
			let endPrefetch: (() => number) | undefined
			let executed: HmrExecutionResult | undefined
			try {
				await runInArtifactGeneration(generation, async () => {
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

					executed = await this.executor.runAndLoadAllClean(coldFiles, true)
					if (prefetchPromise) {
						// Overlap transform prefetch with evaluation to reduce warmup wall time.
						// Await it after evaluation so we don't leave background work behind.
						const prefetch = await prefetchPromise.catch((): undefined => undefined)
						prefetchFailed = prefetch?.failed || undefined
						prefetchMs = roundHmrMs(endPrefetch?.() ?? 0)
					}
				})
				const catalogApplied = this.loaderCatalogSnapshot() !== catalogBefore
				if (!executed || (!executed.commitResult.ok && !catalogApplied)) generation?.rollback()
				else generation?.commit()
				assertHmrExecutionOk(executed, 'HMR warmup')
			} catch (error) {
				await prefetchPromise?.catch((): undefined => undefined)
				if (this.loaderCatalogSnapshot() !== catalogBefore) generation?.commit()
				else generation?.rollback()
				throw error
			}
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
		const statusSnapshot = await this.loader.api.status.snapshot()
		const statusByAddress = new Map(
			(statusSnapshot.statuses ?? []).map((status) => [
				formatPluginNodeReference(status.address),
				status,
			]),
		)
		const report = await buildHmrOperationalReport({
			reason,
			cwd: this.hostRoot,
			anchors: scope.anchors,
			entries: scope.entries,
			rootsAbs: scope.rootsAbs,
			rootsPretty: scope.rootsPretty,
			entriesByRoot: scope.entriesByRoot,
			registryView,
			isPluginDesired: (address) =>
				statusByAddress.get(formatPluginNodeReference(address))?.desiredState === 'running',
			isRunning: (address) => pluginService.isRunning(address),
			resolveBareWorkspaceEntry: (specifier) =>
				this.workspaceEntryResolver.resolveBareWorkspaceEntry(specifier),
			resolveLimit: this.config.reportResolveLimit,
			hotspots: hotspots.length > 0 ? hotspots : undefined,
		})

		this.ctx.logger.info('HMR report', report)
	}
}
