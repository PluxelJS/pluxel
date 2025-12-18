import { fileURLToPath } from 'node:url'
import { type Context, Injectable } from '@pluxel/core'
import { enable as enableDebug } from 'obug'
import { dirname, resolve } from 'pathe'
import { createServer, type DevEnvironment, normalizePath, type Plugin, type ViteDevServer } from 'vite'
import {
	buildHmrViteConfig,
	type HMRDependencyConfig,
	type ResolvedHMRDependencyConfig,
	resolveFsAllowList,
	resolveHMRDependencyConfig,
} from './config'
import { HmrEnvironment, type HmrPathApi, type HmrToolkit } from './environment'
import { BatchDebouncer, findNearestPackageRoot, matchesSpecifierPattern, startTimer } from './internals'
import {
	createHmrDebug,
	formatAttributionReport,
	type HMRLogConfig,
	type ResolvedHMRLogConfig,
	resolveHmrLogConfig,
	TimingTracker,
	toDebugNamespaceString,
} from './logging'
import { HmrBatchProcessor, HmrExecutor, collectColdStartEntries } from './pipeline'
import { HmrRunner } from './runner'
import {
	installRequireShims,
	type RuntimeShimConfig,
	RuntimeShimRegistry,
} from './runtime-shims'

export interface HMRConfig {
	/** 业务扫描边界：仅这些目录下的 `.ts` 会被纳入 HMR 入口挑选（`.tsx` 通常由浏览器端 HMR 处理） */
	dir: string[]
	/** 额外允许 Vite Dev Server 访问的目录（绝对路径或会基于 cwd 解析的相对路径） */
	fsAllow?: string[]
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
	/** 日志与调试开关 */
	log?: HMRLogConfig
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
const HMR_EXPORT_CONDITIONS = ['@pluxel/hmr', '@pluxel/source', 'import', 'module', 'default'] as const

declare module '@pluxel/core' {
	interface Context {
		[serviceName]: HMRService
	}
	namespace Context {
		interface Config {
			[serviceName]: HMRConfig
		}
	}
}

const unique = <T>(iter: Iterable<T>) => Array.from(new Set(iter))

@Injectable({ key: serviceName })
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

	private readonly deps: ResolvedHMRDependencyConfig
	private readonly runtimeShims: RuntimeShimRegistry
	private readonly useRequireShims: boolean

	private readonly logConfig: ResolvedHMRLogConfig
	private readonly timing: TimingTracker

	private readonly workspaceEntryResolveCache = new Map<string, Promise<string | null>>()
	private readonly anchorsCleanCache = new Set<string>()

	private debouncer!: BatchDebouncer

	private readonly dbg: {
		modules: ReturnType<typeof createHmrDebug>
		warmup: ReturnType<typeof createHmrDebug>
		batch: ReturnType<typeof createHmrDebug>
		cache: ReturnType<typeof createHmrDebug>
		graph: ReturnType<typeof createHmrDebug>
	}

	private readonly plugin: Plugin
	private readonly workspaceConditions = [...HMR_EXPORT_CONDITIONS]

	constructor(
		private readonly ctx: Context,
		private readonly config: HMRConfig,
	) {
		this.scanRootsAbs = unique(this.config.dir.map((dir) => normalizePath(resolve(this.cwd, dir))))
		this.env = new HmrEnvironment(this.ctx, {
			cwd: this.cwd,
			scanRootsAbs: this.scanRootsAbs,
			workspaceConditions: this.workspaceConditions,
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
			Boolean(runtimeResolved.shimReflectMetadata) || Object.keys(runtimeResolved.shims ?? {}).length > 0
		if (this.useRequireShims) installRequireShims((id) => this.runtimeShims.require(id))

		const useColors = this.logConfig.useColors
		this.dbg = {
			modules: createHmrDebug('pluxel:hmr:modules', useColors),
			warmup: createHmrDebug('pluxel:hmr:warmup', useColors),
			batch: createHmrDebug('pluxel:hmr:batch', useColors),
			cache: createHmrDebug('pluxel:hmr:cache', useColors),
			graph: createHmrDebug('pluxel:hmr:graph', useColors),
		}

		this.timing = new TimingTracker({
			useColors,
			formatId: (id) => this.path.pretty(id),
		})

		const ns = toDebugNamespaceString(this.logConfig.debugNamespaces)
		if (ns) enableDebug(ns)

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

	public primeModuleCacheEntry(params: { id: string; exports: any; aliases?: Iterable<string> }) {
		this.runner.primeModuleCacheEntry(params)
	}

	public dropModuleCacheEntries(ids: Iterable<string>) {
		this.runner.dropModuleCacheEntries(ids)
	}

	public async start(): Promise<void> {
		const serverFsAllow = resolveFsAllowList({
			cwd: this.cwd,
			cwdNormalized: this.env.paths.cwdNormalizedPath,
			scanRoots: this.scanRootsAbs,
			configFsAllow: Array.isArray(this.config.fsAllow) ? this.config.fsAllow : undefined,
			hmrPackageRoot,
		})
		const serverConfig = buildHmrViteConfig({
			root: this.cwd,
			fsAllow: serverFsAllow,
			scanDirs: this.config.dir,
			deps: this.deps,
			runnerPlugin: this.plugin,
			honoPlugin: this.ctx.honoService.viteHonoDevServer,
		})
		const server = await createServer(serverConfig)
		await server.listen()
		server.printUrls()
		this.ctx.logger.info(`HMR 服务已启动，只监听：${this.config.dir.join(', ')}`)
	}

	private createRunnerPlugin(): Plugin {
		const service = this
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

					await this.runner.bridgeHostModules(this.deps.bridgeModules, this.path, this.ctx.logger as any)
					await this.runner.assertBridgedSingletons(this.deps.bridgeModules)

					this.executor = new HmrExecutor(
						this.ctx,
						this.runner,
					this.path,
					this.timing,
					{
						dbgModules: this.dbg.modules.enabled ? this.dbg.modules : null,
						useRequireShims: this.useRequireShims,
					},
				)

				this.batchProcessor = new HmrBatchProcessor(
					this.ctx,
					this.ssrEnv,
					this.runner,
					this.executor,
					this.path,
					this.toolkit,
					this.timing,
					{
						attribution: (this.config.attribution ?? 'prefetch') === 'prefetch' ? 'prefetch' : 'off',
						prefetchLimit: this.config.prefetchLimit ?? DEFAULT_PREFETCH_LIMIT,
						prefetchOrder: this.config.prefetchOrder ?? 'near',
						prefetchConcurrency: PREFETCH_CONCURRENCY,
					},
					{
						batch: this.dbg.batch.enabled ? this.dbg.batch : null,
						cache: this.dbg.cache.enabled ? this.dbg.cache : null,
						graph: this.dbg.graph.enabled ? this.dbg.graph : null,
					},
					() => this.getAnchorsClean(),
				)

				this.setupBatching()
				this.registerWatchers(server)
				await this.performColdStart()
			},

			handleHotUpdate: async (ctx0) => {
				this.enqueueFileChange(ctx0.file)
				return []
			},

			resolveId: async function (id, importer) {
				const shimResolved = service.runtimeShims.resolveId(id)
				if (shimResolved) return shimResolved

				if (service.ctx.scanService) {
					// Never let workspace resolution rewrite bridged singleton modules, otherwise we may end up
					// evaluating a second copy (e.g. workspace TS sources) in the runner.
					if (service.isHardBridgeModule(id) || service.isBridgeModule(id)) {
						return null
					}

					const resolved = await service.resolveBareWorkspaceEntry(id, importer ?? null)
					if (resolved) return { id: resolved }
				}
				return null
			},

			load: (id) => {
				return service.runtimeShims.load(id)
			},
		}
		return plugin
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
			(error) => this.ctx.logger.error({ error }, '[HMR] batch flush failed'),
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
			anchors: this.ctx.loader.pathAnchors,
			path: this.path,
			scanService: this.ctx.scanService,
			workspaceConditions: this.workspaceConditions,
		})
		this.ctx.logger.info('[HMR] scan: %d files in %sms', entries.length, endScan().toFixed(1))

		const endWarmup = startTimer()
		const coldFiles = unique(entries.map((p) => this.path.toClean(p))).sort()

		if (this.dbg.warmup.enabled) {
			this.dbg.warmup(
				'files (%n): %l',
				coldFiles.length,
				coldFiles.map((f) => this.path.pretty(f)),
			)
		}

		const executed = await this.executor.runAndLoadAll(coldFiles, true)
		if (executed) this.ctx.logger.info('[HMR] commit: %sms', executed.commitMs.toFixed(1))

		this.ctx.logger.info('[HMR] warmup: %d files in %sms', coldFiles.length, endWarmup().toFixed(1))

		this.ctx.logger.info(
			formatAttributionReport({
				changed: coldFiles[0] ?? 'N/A',
				targets: coldFiles,
				timing: this.timing,
				prettyId: (id) => this.path.pretty(id),
			}),
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
		for (const a of this.ctx.loader.pathAnchors ?? new Set<string>()) this.anchorsCleanCache.add(this.path.toClean(a))
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
