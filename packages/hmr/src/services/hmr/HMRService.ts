import { fileURLToPath } from 'node:url'
import type { Logger as LogtapeLogger } from '@logtape/logtape'
import { type Context, Injectable } from '@pluxel/core'
import { getDebugLogger, resolveDebugTopics } from '@pluxel/core/logger'
import { dirname, isAbsolute, resolve } from 'pathe'
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
	BatchDebouncer,
	findNearestPackageRoot,
	matchesSpecifierPattern,
	startTimer,
} from './internals'
import {
	type HMRLogConfig,
	logAttributionReport,
	type ResolvedHMRLogConfig,
	resolveHmrLogConfig,
	TimingTracker,
} from './logging'
import { ensureHmrLogtapeConfigured } from './logtape'
import { collectColdStartEntries, HmrBatchProcessor, HmrExecutor } from './pipeline'
import { HmrRunner } from './runner'
import { installRequireShims, type RuntimeShimConfig, RuntimeShimRegistry } from './runtime-shims'

export interface HMRConfig {
	/** 业务扫描边界：默认仅这些目录下的 `.ts` 会被纳入 HMR 入口挑选（`.tsx`/`.jsx` 默认排除） */
	dir: string[]
	/**
	 * 额外的 HMR include glob（优先级高于默认的 `dir/**` + `.ts`）。
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
	/**
	 * 冷启动策略（HMRService.start 阶段）。
	 * - blocking: 启动时同步跑一遍 cold start（默认，保证启动后插件列表已就绪）
	 * - background: 先启动服务，后台执行 cold start（更快返回，首次 UI/插件状态可能稍后才完整）
	 * - off: 不执行 cold start（仅监听文件变更 + 手动 executeFiles）
	 */
	coldStart?: 'blocking' | 'background' | 'off'
	/** 计时归因策略：'off' 关闭预取归因，仅保留 evaluate/inject；'prefetch' 预取受影响文件做 transform 计时（默认） */
	attribution?: 'off' | 'prefetch'
	/** 预取上限：避免超大变更范围引发 storm（默认 200） */
	prefetchLimit?: number
	/** 预取排序策略：'near' 按与变更点的上行距离从近到远（默认）；'all' 仅按字典序 */
	prefetchOrder?: 'near' | 'all'
	/** 批处理参数 */
	batch?: {
		/** 首次触发后的防抖窗口（ms） */
		debounceMs?: number
		/** 单批最大等待（ms），兜底出批 */
		maxWaitMs?: number
		/** 单批最大文件数 */
		maxBatchFiles?: number
	}
	/** 依赖相关配置（external / bridge / optimizeDeps 等） */
	deps?: HMRDependencyConfig
	/** 日志与调试开关（含 LogTape 自动默认配置；可在此覆盖 file/ui 等） */
	log?: HMRLogConfig
	/**
	 * 额外的 Vite 插件（仅用于 HMR dev server）。
	 *
	 * 用途示例：
	 * - 下游自己加宏：`import Macros from 'unplugin-macros/vite'; vitePlugins: [Macros()]`
	 */
	vitePlugins?: Plugin[]
	/** 插件执行环境（Vite ModuleRunner）运行时行为 */
	runtime?: {
		/**
		 * 将 `reflect-metadata`（以及 `reflect-metadata/*`）替换为空实现，避免污染宿主全局 Reflect。
		 * - 对 `import 'reflect-metadata'` / `require('reflect-metadata')` 都生效
		 */
		shimReflectMetadata?: boolean
		/**
		 * 自定义运行时 shim（resolveId/load 阶段覆写模块）。
		 * - key 精确匹配：`foo`
		 * - key 前缀匹配：`foo/*` 匹配 `foo/anything`
		 */
		shims?: Record<string, RuntimeShimConfig>
	}

	/**
	 * Preloaded plugin constructors that ship with `@pluxel/hmr` (or other libraries) and should be enabled
	 * without needing a scanned entry file.
	 *
	 * This is intentionally constructor-based (not string names) so callers can pass imports directly when
	 * creating a `Context` in TS/JS.
	 */
	builtins?: readonly (BuiltinPluginSpec)[]
}

const DEFAULT_PREFETCH_LIMIT = 200
const PREFETCH_CONCURRENCY = 8

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

@Injectable({ key: serviceName, scope: 'root' })
export class HMRService {
	public vite!: ViteDevServer

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

	private readonly logConfig: ResolvedHMRLogConfig
	private readonly timing: TimingTracker

	private readonly workspaceEntryResolveCache = new Map<string, Promise<string | null>>()
	private readonly anchorsCleanCache = new Set<string>()
	private didPreloadBuiltins = false

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
		this.scanRootsAbs = unique(this.config.dir.map((dir) => normalizePath(resolve(this.cwd, dir))))
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
		this.logConfig = resolveHmrLogConfig(this.config.log)

		const runtimeInput = this.config.runtime ?? {}
		const runtimeResolved = {
			...runtimeInput,
			shimReflectMetadata: runtimeInput.shimReflectMetadata ?? true,
		}
		this.runtimeShims = new RuntimeShimRegistry(runtimeResolved)
		this.useRequireShims =
			Boolean(runtimeResolved.shimReflectMetadata) ||
			Object.keys(runtimeResolved.shims ?? {}).length > 0
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
	public executeFiles(filesPath: readonly string[], keepOrder = true) {
		if (!this.executor) {
			throw new Error('HMRService not initialized (Vite server not configured yet)')
		}
		return this.executor.runAndLoadAll(filesPath, keepOrder)
	}

	public async start(): Promise<void> {
		const rootConfig = (this.ctx.root?.config ?? this.ctx.config ?? {}) as unknown
		await ensureHmrLogtapeConfigured({
			...this.logConfig.logtape,
			debug: resolveDebugTopics(rootConfig),
		})

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
			scanDirs: this.config.dir,
			deps: this.deps,
			extraPlugins: this.config.vitePlugins,
			runnerPlugin: this.plugin,
			honoPlugin: this.ctx.honoService.viteHonoDevServer,
			includeGlobs: this.includeGlobs,
			excludeGlobs: this.excludeGlobs,
		})
		const server = await createServer(serverConfig)
		await server.listen()
		server.printUrls()
		this.ctx.logger.info`HMR 服务已启动，只监听：${this.config.dir.join(', ')}`
	}

	private createRunnerPlugin(): Plugin {
		const plugin: Plugin = {
			name: 'pluxel-runner',
			enforce: 'pre',
			apply: 'serve',

			configureServer: async (server) => {
				this.vite = server
				this.setServerRoot(server.config.root)

				this.runner.init(server, {
					cjsExternal: this.deps.cjsExternal,
					bridgeModules: this.deps.bridgeModules,
					skipPlugin: this.plugin,
				})
				this.ssrEnv = this.runner.env

				await this.runner.bridgeHostModules(
					this.deps.bridgeModules,
					this.path,
					this.ctx.logger as unknown as { warn: (...args: unknown[]) => void },
				)
				await this.runner.assertBridgedSingletons(this.deps.bridgeModules)

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
						attribution:
							(this.config.attribution ?? 'prefetch') === 'prefetch' ? 'prefetch' : 'off',
						prefetchLimit: this.config.prefetchLimit ?? DEFAULT_PREFETCH_LIMIT,
						prefetchOrder: this.config.prefetchOrder ?? 'near',
						prefetchConcurrency: PREFETCH_CONCURRENCY,
					},
					{
						batch: this.dbg.batch,
						cache: this.dbg.cache,
						graph: this.dbg.graph,
					},
					() => this.getAnchorsClean(),
				)

				this.setupBatching()
				this.registerWatchers(server)
				await this.preloadBuiltins()
				const mode = this.config.coldStart ?? 'blocking'
				if (mode === 'off') return
				if (mode === 'background') {
					void this.performColdStart().catch((error) => {
						this.ctx.logger.error('cold start failed', { error })
					})
					return
				}
				await this.performColdStart()
			},

			handleHotUpdate: async (ctx0) => {
				this.enqueueFileChange(ctx0.file)
				return []
			},

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

	private async preloadBuiltins(): Promise<void> {
		if (this.didPreloadBuiltins) return
		this.didPreloadBuiltins = true

		const builtins = this.config.builtins
		if (!builtins?.length) return

		const config = this.ctx.configService
		if (!config.isReady) await config.ready

		// Commit builtins as a baseline so later loader batch rollbacks revert back to a container
		// that already includes the built-in plugins.
		await this.ctx.loader.preloadPlugins(builtins, { commit: true })
	}

	private setupBatching() {
		const bCfg = {
			debounceMs: this.config.batch?.debounceMs ?? 30,
			maxWaitMs: this.config.batch?.maxWaitMs ?? 120,
			maxBatchFiles: this.config.batch?.maxBatchFiles ?? 2000,
		}
		this.debouncer = new BatchDebouncer(
			(files, epoch) => this.batchProcessor.process(files, epoch),
			bCfg.debounceMs,
			bCfg.maxWaitMs,
			bCfg.maxBatchFiles,
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
		const anchors = this.getAnchorsClean()
		if (!anchors.has(clean) && !this.toolkit.pathFilter(clean)) return false
		this.debouncer.push(clean)
		return true
	}

	private async performColdStart() {
		const endScan = startTimer()
		const entries = await collectColdStartEntries({
			rootsAbs: this.scanRootsAbs,
			anchors: this.getAnchorsClean(),
			path: this.path,
			scanService: this.ctx.scanService,
			workspaceConditions: this.workspaceConditions,
		})
		const scanMs = Math.round(endScan() * 10) / 10
		this.ctx.logger.info`scan: ${entries.length} files in ${scanMs}ms`

		const endWarmup = startTimer()
		const coldFiles = unique(entries.map((p) => this.path.toClean(p))).sort()

		const prettyFiles = coldFiles.map((f) => this.path.pretty(f))
		this.dbg.warmup.debug(
			(l) => l`files (${prettyFiles.length})\n${prettyFiles.map((f) => `    ${f}`).join('\n')}`,
		)

		const executed = await this.executor.runAndLoadAll(coldFiles, true)
		if (executed) {
			const commitMs = Math.round(executed.commitMs * 10) / 10
			this.ctx.logger.info`commit: ${commitMs}ms`
		}

		const warmupMs = Math.round(endWarmup() * 10) / 10
		this.ctx.logger.info`warmup: ${coldFiles.length} files in ${warmupMs}ms`

		logAttributionReport(
			this.ctx.logger,
			{
				changed: coldFiles[0] ?? 'N/A',
				targets: coldFiles,
				timing: this.timing,
				prettyId: (id) => this.path.pretty(id),
			},
			{ level: 'info' },
		)
	}

	private resolveBareWorkspaceEntry(specifier: string, importer: string | null) {
		const cached = this.workspaceEntryResolveCache.get(specifier)
		if (cached) return cached
		const p = this.env.resolveBareWorkspaceModule(specifier, importer).catch(() => null)
		this.workspaceEntryResolveCache.set(specifier, p)
		return p
	}

	private getAnchorsClean() {
		this.anchorsCleanCache.clear()
		for (const a of this.ctx.loader.api.anchors.list()) {
			const clean = this.path.toClean(a)
			if (!this.toolkit.pathFilter(clean)) continue
			this.anchorsCleanCache.add(clean)
		}
		return this.anchorsCleanCache
	}

	private isBridgeModule(specifier: string) {
		for (const pattern of this.deps.bridgeModules) {
			if (matchesSpecifierPattern(specifier, pattern)) return true
		}
		return false
	}

	private isHardBridgeModule(specifier: string) {
		if (specifier === '@pluxel/core' || specifier.startsWith('@pluxel/core/')) return true
		if (specifier === '@pluxel/hmr' || specifier.startsWith('@pluxel/hmr/')) return true
		if (specifier === '@pluxel/context' || specifier.startsWith('@pluxel/context/')) return true
		return false
	}
}

function resolveGlobPatterns(
	patterns: readonly string[] | undefined,
	cwd: string,
): string[] | undefined {
	if (!patterns?.length) return undefined
	return patterns.map((pattern) => {
		const negated = pattern.startsWith('!')
		const raw = negated ? pattern.slice(1) : pattern
		const normalized = isAbsolute(raw) ? normalizePath(raw) : normalizePath(resolve(cwd, raw))
		return negated ? `!${normalized}` : normalized
	})
}
