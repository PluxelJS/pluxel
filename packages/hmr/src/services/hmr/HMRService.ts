import { fileURLToPath } from 'node:url'
import { type Context, Injectable } from '@pluxel/core'
import { enable as enableDebug } from 'obug'
import { dirname, resolve } from 'pathe'
import { glob } from 'tinyglobby'
import { createServer, type ModuleNode, normalizePath, type Plugin, type ViteDevServer } from 'vite'
import { type ModuleCacheMap, ViteNodeRunner } from 'vite-node/client'
import { ViteNodeServer } from 'vite-node/server'
import { installSourcemapsSupport } from 'vite-node/source-map'
import {
	buildHmrViteConfig,
	type HMRDependencyConfig,
	type ResolvedHMRDependencyConfig,
	resolveFsAllowList,
	resolveHMRDependencyConfig,
} from './config'
import {
	BatchDebouncer,
	findNearestPackageRoot,
	Mutex,
	NormalizedModuleCacheMap,
	startTimer,
} from './internals'
import { HmrEnvironment, type HmrPathApi, type HmrToolkit } from './environment'
import {
	createHmrDebug,
	type HMRLogConfig,
	formatAttributionReport,
	type ResolvedHMRLogConfig,
	resolveHmrLogConfig,
	TimingTracker,
	toDebugNamespaceString,
} from './logging'

/* -------------------------------- 配置项 -------------------------------- */

export interface HMRConfig {
	/** 业务扫描边界：仅这些目录下的 .ts/.tsx 会被纳入 HMR 入口挑选 */
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
}

/* --------------------------------- 常量 --------------------------------- */

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
const HMR_EXPORT_CONDITIONS = [
	'@pluxel/hmr',
	'@pluxel/source',
	'import',
	'module',
	'default',
] as const
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

/* --------------------------------- 工具 --------------------------------- */

const unique = <T>(iter: Iterable<T>) => Array.from(new Set(iter))

type RootInfo = { raw: string; normalized: string }
type BatchGraphContext = {
	affectedIds: Set<string>
	rootsAll: string[]
	distance: Map<string, number>
}

/* ------------------------------ HMR Service ----------------------------- */
/**
 * HMRService（anchors 实时读取 + 计时归因 + 批处理串行）
 * - 不镜像 loader 状态；实时读取 this.ctx.loader.pathAnchors（SSOT）
 * - 统一 cleanId（POSIX + 去查询串）以对齐 moduleGraph / anchors
 * - 计时拆账：transform（预取）/ evaluate（入口）/ inject（replaceModule）
 * - 批处理：防抖聚合 + 最长等待兜底 + 串行互斥
 */
@Injectable({ key: serviceName })
export class HMRService {
	private vite!: ViteDevServer
	private vns!: ViteNodeServer
	private runner!: ViteNodeRunner
	private readonly cwd = process.cwd()
	private readonly scanRootsAbs: string[]
	private readonly env: HmrEnvironment
	/** 路径规范化 / 过滤 / 解析的组合工具，便于外部复用 */
	public readonly toolkit!: HmrToolkit
	/** path 工具快捷访问（兼容现有调用） */
	public readonly path!: HmrPathApi
	private readonly moduleCache: NormalizedModuleCacheMap

	/** 依赖/模块行为：external、bridge、optimizeDeps 等 */
	private readonly deps: ResolvedHMRDependencyConfig

	private plugin!: Plugin

	/** obug 驱动的计时收集 */
	private timing: TimingTracker

	/** 串行互斥 + 防抖出批 */
	private mutex = new Mutex()
	private debouncer!: BatchDebouncer

	/** 最近锚点缓存（按批清空，批内复用） */
	private anchorCache = new Map<string, string | null>()

	/** 日志控制 */
	private readonly logConfig: ResolvedHMRLogConfig
	/** obug 细粒度调试（默认关闭，需 DEBUG=pluxel:hmr:* 开启） */
	private readonly dbg: {
		modules: ReturnType<typeof createHmrDebug>
		warmup: ReturnType<typeof createHmrDebug>
		batch: ReturnType<typeof createHmrDebug>
		cache: ReturnType<typeof createHmrDebug>
		graph: ReturnType<typeof createHmrDebug>
	}
	private readonly workspaceConditions = [...HMR_EXPORT_CONDITIONS]

	constructor(
		private ctx: Context,
		private config: HMRConfig,
	) {
		this.scanRootsAbs = unique(this.config.dir.map((dir) => normalizePath(resolve(this.cwd, dir))))
		this.env = new HmrEnvironment(this.ctx, {
			cwd: this.cwd,
			scanRootsAbs: this.scanRootsAbs,
			workspaceConditions: this.workspaceConditions,
		})
		this.toolkit = this.env.toolkit
		this.path = this.toolkit.path
		this.moduleCache = new NormalizedModuleCacheMap((id) => this.path.toClean(id))
		this.deps = resolveHMRDependencyConfig(this.config.deps)
		this.logConfig = resolveHmrLogConfig(this.config.log)

		// 初始化所有 debug 实例
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

		// 可选开启 obug namespace（否则遵循 DEBUG 环境变量）
		const ns = toDebugNamespaceString(this.logConfig.debugNamespaces)
		if (ns) enableDebug(ns)

		this.plugin = {
			name: 'pluxel-runner',
			apply: 'serve',

			/** DevServer 生命周期：桥接 vite-node、预热业务代码、注册监听 */
			configureServer: async (server) => {
				this.vite = server
				this.setServerRoot(server.config.root)
				await this.initRunner(server)
				await this.bridgeWorkspaceModules(this.deps.bridgeModules)
				this.setupBatching()
				this.registerWatchers(server)
				await this.performColdStart()
			},

			/** 服务端 HMR：仅入队，由批处理串行执行 */
			handleHotUpdate: async (ctx0) => {
				this.enqueueFileChange(ctx0.file, 'change')
				return [] // 服务端 HMR 由我们全权处理
			},
		}
	}

	public get moduleCacheMap(): ModuleCacheMap {
		return this.moduleCache
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

	/** Allow external services (e.g. PackageService) to hydrate or refresh runner cache entries. */
	public primeModuleCacheEntry(params: { id: string; exports: any; aliases?: Iterable<string> }) {
		const cacheEntry = {
			exports: params.exports,
			evaluated: true,
			imports: new Set<string>(),
			importers: new Set<string>(),
			promise: Promise.resolve(params.exports),
		}
		const ids = new Set<string>([params.id, ...(params.aliases ?? [])])
		for (const rawId of ids) {
			const cleanId = this.path.toClean(rawId)
			this.moduleCache.set(cleanId, { ...cacheEntry })
		}
	}

	/** Remove module cache mappings for a set of ids (any alias form is accepted). */
	public dropModuleCacheEntries(ids: Iterable<string>) {
		for (const rawId of ids) {
			const cleanId = this.path.toClean(rawId)
			this.moduleCache.delete(cleanId)
		}
	}

	/* ------------------------- DevServer lifecycle helpers ------------------------- */

	private async initRunner(server: ViteDevServer) {
		this.vns = new ViteNodeServer(server, {
			transformMode: { ssr: [/\.([cm]?tsx?|jsx?)$/] },
			deps: {
				external: Array.from(this.deps.runnerExternal),
			},
		})

		installSourcemapsSupport({ getSourceMap: (src) => this.vns.getSourceMap(src) })

		this.runner = new ViteNodeRunner({
			root: server.config.root,
			base: server.config.base,
			moduleCache: this.moduleCache,
			fetchModule: async (id) => {
				const clean = this.path.toClean(id)
				const end = this.timing.start('transform', clean)
				const result = await this.vns.fetchModule(id)
				end()
				return result
			},
			resolveId: async (id, importer) => {
				const resolved = await this.vns.resolveId(id, importer)
				if (resolved) return resolved
				const bareResolved = await this.env.resolveBareModule(id, importer)
				return bareResolved ? { id: bareResolved } : null
			},
		})
	}

	private setupBatching() {
		const bCfg = {
			debounceMs: this.config.batch?.debounceMs ?? 30,
			maxWaitMs: this.config.batch?.maxWaitMs ?? 120,
			maxBatchFiles: this.config.batch?.maxBatchFiles ?? 2000,
		}
		this.debouncer = new BatchDebouncer(
			(files, epoch) => this.mutex.run(() => this.processBatch(files, epoch)),
			bCfg.debounceMs,
			bCfg.maxWaitMs,
			bCfg.maxBatchFiles,
			(error) => this.ctx.logger.error({ error }, '[HMR] batch flush failed'),
		)
	}

	private registerWatchers(server: ViteDevServer) {
		server.watcher.on('change', (file) => {
			this.enqueueFileChange(file, 'change')
		})
		server.watcher.on('add', (file) => {
			this.enqueueFileChange(file, 'add')
		})
		server.watcher.on('unlink', (file) => {
			this.enqueueFileChange(file, 'unlink')
		})
	}

	private enqueueFileChange(file: string, _kind: 'change' | 'add' | 'unlink') {
		const clean = this.path.toClean(file)
		if (!this.toolkit.pathFilter(clean)) return false

		this.debouncer.push(clean)
		return true
	}

	private async performColdStart() {
		const endScan = startTimer()
		const files = await this.collectSourceEntries(this.scanRootsAbs)
		this.ctx.logger.info('[HMR] scan: %d files in %sms', files.length, endScan().toFixed(1))

		const endWarmup = startTimer()
		const coldFiles = unique(files.map((p) => this.path.toClean(p))).sort()

		if (this.dbg.warmup.enabled) {
			this.dbg.warmup(
				'files (%n): %l',
				coldFiles.length,
				coldFiles.map((f) => this.path.pretty(f)),
			)
		}

		await this.runAndLoadAll(coldFiles, /*keepOrder*/ true)
		this.ctx.logger.info('[HMR] warmup: %d files in %sms', coldFiles.length, endWarmup().toFixed(1))
	}

	private async collectSourceEntries(roots: string[]): Promise<string[]> {
		if (!roots.length) return []
		const entries = new Set<string>()
		for (const anchor of this.ctx.loader.pathAnchors) {
			const clean = this.path.toClean(anchor)
			entries.add(clean)
		}
		const rootInfos: RootInfo[] = roots.map((raw) => ({
			raw,
			normalized: normalizePath(raw),
		}))
		const workspaceResult = await this.tryCollectWorkspaceEntries(rootInfos)
		if (workspaceResult) {
			for (const entry of workspaceResult.entries) {
				entries.add(entry)
			}
		}
		const coveredRoots = workspaceResult?.covered
		const uncovered = rootInfos
			.filter((info) => !coveredRoots?.has(info.normalized))
			.map((info) => info.raw)
		if (uncovered.length) {
			const fallbackEntries = await this.collectDirectoryFallbackEntries(uncovered)
			for (const entry of fallbackEntries) entries.add(entry)
		}
		return [...entries]
	}

	private async tryCollectWorkspaceEntries(rootInfos: RootInfo[]) {
		const scanService = this.ctx.scanService
		if (!scanService) return null
		const roots = rootInfos.map((info) => info.raw)
		try {
			const workspaceEntries = await scanService.listWorkspaceEntries({
				roots,
				workspaceOnly: true,
				scan: {
					preferHmrExports: true,
					conditions: this.workspaceConditions as unknown as string[],
				},
			})
			const covered = new Set<string>()
			const entries: string[] = []
			for (const pkg of workspaceEntries) {
				const entryId = this.path.toClean(pkg.entry)
				entries.push(entryId)
				const dirNorm = normalizePath(pkg.dir)
				for (const info of rootInfos) {
					if (!covered.has(info.normalized) && dirNorm.startsWith(info.normalized)) {
						covered.add(info.normalized)
						break
					}
				}
			}
			return { entries, covered }
		} catch {
			return null
		}
	}

	private async collectDirectoryFallbackEntries(roots: string[]): Promise<string[]> {
		if (!roots.length) return []
		const patterns = roots.flatMap((root) => [`${root}/**/*.ts`, `${root}/**/*.tsx`])
		const files = await glob(patterns, {
			absolute: true,
			onlyFiles: true,
			ignore: ['**/*.d.ts', '**/node_modules/**'],
		})
		return unique(files.map((file) => this.path.toClean(file)))
	}

	/* ------------------------------ 执行 + 注入 ------------------------------ */

	/**
	 * 逐入口执行 + 交给 loader 注入（replaceModule）
	 * - 顺序执行以保证副作用时序稳定
	 * - 计时：evaluate（入口执行）与 inject（注册/注入）
	 * - 失败隔离：单入口失败不阻断整批；最终 commit 一次
	 */
	private async runAndLoadAll(filesPath: string[], keepOrder = true) {
		if (!filesPath.length) return undefined

		const dedup = unique(filesPath.map((p) => this.path.toClean(p)))
		const ordered = keepOrder ? dedup : [...dedup]

		// Batch-inject should be atomic at the loader layer:
		// - If core commit/build fails, we must roll back loader declaration state, otherwise
		//   loader will think a plugin is loaded/enabled while core never switched containers.
		const batch = this.ctx.loader.beginBatch()

		for (const id of ordered) {
			const endEvaluate = this.timing.start('evaluate', id)
			let mod: any
			try {
				mod = await this.runner.executeFile(id) // Evaluate 入口
			} catch (err) {
				this.ctx.logger.error({ file: id, err }, '[HMR] execute failed')
				continue
			}
			const evaluateMs = endEvaluate()

			const endInject = this.timing.start('inject', id)
			let hasPlugin = false
			try {
				hasPlugin = await batch.replaceModule(id, mod)
			} catch (err) {
				this.ctx.logger.error({ file: id, err }, '[HMR] replaceModule failed')
				// Do not continue with a partially mutated loader/core draft.
				batch.rollback()
				this.ctx.registry.resetDraft()
				return undefined
			}
			const injectMs = endInject()

			// 使用格式化器：%p 路径高亮，%t 时间高亮，%b 布尔高亮
			this.dbg.modules(
				'execute %p: eval=%t inject=%t plugin=%b',
				this.path.pretty(id),
				evaluateMs,
				injectMs,
				hasPlugin,
			)
		}

		const endCommit = startTimer()
		const res = await this.ctx.registry.commit()
		this.ctx.logger.info('[HMR] commit: %sms', endCommit().toFixed(1))

		if (!res.ok) {
			batch.rollback()
			// commit() build failures already attempt an internal rollback, but we keep a
			// direct resetDraft() here to ensure no leftover uncommitted ops linger.
			this.ctx.registry.resetDraft()
		} else {
			batch.commit()
		}

		return res
	}

	/**
	 * Ensure vite-node reuses host exports for selected workspace packages so plugins see the same
	 * class singletons (BasePlugin、核心 Service 等) during hot reload.
	 */
	private async bridgeWorkspaceModules(specifiers: readonly string[]) {
		for (const specifier of specifiers) {
			try {
				// 1. vite-node 告诉我们它会以哪个 id 访问该模块
				const resolved1 = await this.vns.resolveId(specifier)
				if (!resolved1) continue

				// 2. 从宿主 runtime 获取已经加载好的实例（通过普通 import）
				const exports = await import(specifier)

				// 3. 在 moduleCache 中写入“已执行”的结果
				const cacheEntry = {
					exports,
					evaluated: true,
					imports: new Set<string>(),
					importers: new Set<string>(),
					promise: Promise.resolve(exports),
				}

				// 4. 同一模块可能被以多种 key 访问，尽可能覆盖
				const ids = new Set<string>([specifier, resolved1.id, this.path.toClean(resolved1.id)])

				const resolved2 = await this.vns.resolveId(resolved1.id)
				if (resolved2?.id) {
					ids.add(resolved2.id)
					ids.add(this.path.toClean(resolved2.id))
				}

				const aliases = [...ids].filter((id) => id !== specifier)
				this.primeModuleCacheEntry({
					id: specifier,
					exports,
					aliases,
				})
			} catch (error) {
				this.ctx.logger.warn({ specifier, error }, '[HMR] 无法桥接工作区模块')
			}
		}
	}

	/* ------------------------------ DevServer 启动 ------------------------------ */

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

	/* --------------------------- Graph / 受影响子图 --------------------------- */

	/** 从 FS 路径拿到 graph 模块节点（兼容 byFile / byId 两支） */
	private getModulesByFile(fileOrId: string) {
		const variants = this.path.variants(fileOrId)
		for (const variant of variants) {
			const byFile = this.vite.moduleGraph.getModulesByFile(variant)
			if (byFile?.size) return [...byFile]
		}
		for (const variant of variants) {
			const single = this.vite.moduleGraph.getModuleById(variant)
			if (single) return [single]
		}
		return []
	}

	/**
	 * 受影响收集（仅业务边界）
	 * - 自底向上沿 importers 递归，将命中 pathFilter 且非虚拟模块(\0) 的节点纳入
	 * - roots：受影响集合中“其 importer 不在集合内”的最上游节点（兜底执行）
	 * - distance：自变更点起的上行 BFS 距离（用于预取排序）
	 */
	private collectAffected(fileOrId: string) {
		const startMods = this.getModulesByFile(fileOrId)
		const visited = new Set<string>()
		const affectedIds = new Set<string>()
		const idToMod = new Map<string, ModuleNode>()
		const distance = new Map<string, number>()

		const queue: Array<{ m: ModuleNode; d: number }> = []
		for (const m of startMods) queue.push({ m, d: 0 })

		let cursor = 0
		while (cursor < queue.length) {
			const { m, d } = queue[cursor++]
			if (!m?.id) continue
			const id = this.path.toClean(m.id)
			if (!this.toolkit.pathFilter(id) || id.startsWith('\0')) continue
			if (visited.has(id)) continue
			visited.add(id)
			affectedIds.add(id)
			idToMod.set(id, m)
			distance.set(id, d)

			for (const importer of m.importers) if (importer?.id) queue.push({ m: importer, d: d + 1 })
		}

		const roots: string[] = []
		for (const id of affectedIds) {
			const m = idToMod.get(id)!
			const hasImporterInside = [...m.importers].some(
				(im) => im.id && affectedIds.has(this.path.toClean(im.id)),
			)
			if (!hasImporterInside) roots.push(id)
		}

		return { affectedIds, roots, distance }
	}

	private collectBatchGraph(files: string[]): BatchGraphContext {
		const affectedIds = new Set<string>()
		const rootsAll: string[] = []
		const distance = new Map<string, number>()

		for (const f of files) {
			const { affectedIds: a, roots, distance: dist } = this.collectAffected(f)
			for (const id of a) affectedIds.add(id)
			rootsAll.push(...roots)
			dist.forEach((d, id) => {
				const prev = distance.get(id)
				if (prev === undefined || d < prev) distance.set(id, d)
			})
		}

		return { affectedIds, rootsAll, distance }
	}

	private logGraphDebug(graph: BatchGraphContext) {
		if (!this.dbg.graph.enabled) return
		const affectedList = [...graph.affectedIds].map((id) => {
			const d = graph.distance.get(id) ?? -1
			return `${this.path.pretty(id)} (d=${d})`
		})
		this.dbg.graph('affected (%n): %l', graph.affectedIds.size, affectedList)
		this.dbg.graph(
			'roots (%n): %l',
			graph.rootsAll.length,
			graph.rootsAll.map((r) => this.path.pretty(r)),
		)
	}

	private pruneMissingModules(files: string[]) {
		for (const f of files) {
			const mods = this.vite.moduleGraph.getModulesByFile(f)
			const exists = mods?.size || this.vite.moduleGraph.getModuleById(f)
			if (!exists) {
				this.ctx.loader.pathAnchors.delete(f)
				this.ctx.loader.pruneModule(f)
			}
		}
	}

	private logBatchList(label: string, files: string[]) {
		if (!this.dbg.batch.enabled) return
		this.dbg.batch(
			'%s (%n): %l',
			label,
			files.length,
			files.map((f) => this.path.pretty(f)),
		)
	}

	/* ------------------------------ 目标挑选（最近锚点） ------------------------------ */

	/**
	 * 读实时 anchors（this.ctx.loader.pathAnchors），对每个受影响点向上 BFS，
	 * 命中第一锚点即返回；若任一节点无锚点可达，则回退执行 roots。
	 * - anchors 可能是任意路径形态，这里统一 cleanId 再判定
	 */
	private pickTargetsByAnchors(
		affectedIds: Set<string>,
		rawRoots: string[],
		pathAnchors: Set<string>,
	) {
		const anchorSet = new Set<string>()
		for (const a of pathAnchors) anchorSet.add(this.path.toClean(a))

		const targets = new Set<string>()
		let needFallbackRoots = false

		for (const id of affectedIds) {
			const anchor = this.findNearestPluginAnchor(id, anchorSet)
			if (anchor) targets.add(anchor)
			else needFallbackRoots = true
		}

		if (needFallbackRoots) for (const r of rawRoots) targets.add(this.path.toClean(r))
		return Array.from(targets)
	}

	/** 在受影响子图内，从起点向上 BFS；命中第一个锚点即返回（最短链路）＋ 批内缓存 */
	private findNearestPluginAnchor(startCleanId: string, anchors: Set<string>) {
		if (this.anchorCache.has(startCleanId)) return this.anchorCache.get(startCleanId)!

		const visited = new Set<string>()
		const queue: ModuleNode[] = []
		for (const m of this.getModulesByFile(startCleanId)) queue.push(m)

		let cursor = 0
		while (cursor < queue.length) {
			const m = queue[cursor++]
			if (!m?.id) continue
			const id = this.path.toClean(m.id)
			if (visited.has(id)) continue
			visited.add(id)

			if (!this.toolkit.pathFilter(id) || id.startsWith('\0')) continue

			if (anchors.has(id)) {
				this.anchorCache.set(startCleanId, id)
				return id
			}

			for (const im of m.importers) if (im?.id) queue.push(im)
		}

		this.anchorCache.set(startCleanId, null)
		return null
	}

	/* ------------------------------ 缓存失效 ------------------------------ */

	/**
	 * 统一失效 Vite transform/SSR 缓存 + vite-node 执行缓存
	 * - 先 graph.invalidate 确保下一步 fetch/execute 拿到最新产物
	 * - 再清模块缓存（含 ?xxx 变体），避免命中旧执行结果
	 */
	private invalidateCaches(affectedIds: Set<string>) {
		const g = this.vite.moduleGraph
		let viteInvalidated = 0
		let runnerInvalidated = 0

		// 1) 失效 Vite 的 transform/ssr 缓存
		for (const id of affectedIds) {
			for (const variant of this.path.variants(id)) {
				const mods = g.getModulesByFile(variant)
				if (mods?.size) {
					for (const m of mods) {
						g.invalidateModule(m)
						viteInvalidated++
					}
				} else {
					const m = g.getModuleById(variant)
					if (m) {
						g.invalidateModule(m)
						viteInvalidated++
					}
				}
			}
		}

		// 2) 失效 vite-node 执行缓存（清理所有查询后缀的等价 key）
		const invalidatedKeys: string[] = []
		for (const key of this.moduleCache.keys()) {
			const base = this.path.toClean(key)
			if (affectedIds.has(base)) {
				this.moduleCache.delete(key)
				runnerInvalidated++
				invalidatedKeys.push(key)
			}
		}

		// 详细输出缓存失效情况（需 DEBUG=pluxel:hmr:cache）
		if (this.dbg.cache.enabled) {
			this.dbg.cache('invalidated: vite=%n runner=%n', viteInvalidated, runnerInvalidated)
			if (invalidatedKeys.length > 0) {
				this.dbg.cache(
					'runner keys: %l',
					invalidatedKeys.map((k) => this.path.pretty(k)),
				)
			}
		}
	}

	/* ------------------------------ 预取（transform 归因） ------------------------------ */

	/** 组装预取列表：按距离排序并限流；或直接取全部（字典序） */
	private buildPrefetchList(
		base: Set<string>,
		distance: Map<string, number>,
		order: 'near' | 'all',
		limit: number,
	) {
		const items = [...base]
		if (order === 'near') {
			items.sort((a, b) => {
				const da = distance.get(a) ?? 1e9
				const db = distance.get(b) ?? 1e9
				return da - db || a.localeCompare(b)
			})
		} else {
			items.sort()
		}
		return items.slice(0, Math.max(1, limit))
	}

	private buildPrefetchPlan(targets: string[], graph: BatchGraphContext) {
		if ((this.config.attribution ?? 'prefetch') !== 'prefetch') return []
		const limit = this.config.prefetchLimit ?? DEFAULT_PREFETCH_LIMIT
		const order = this.config.prefetchOrder ?? 'near'
		const base = targets.length ? new Set(targets) : graph.affectedIds
		return this.buildPrefetchList(base, graph.distance, order, limit)
	}

	/** 仅 transform，不 evaluate；把账记到每个受影响文件 */
	private async prefetchTransforms(ids: Iterable<string>) {
		const seen = new Set<string>()
		const queue: string[] = []
		for (const raw of ids) {
			const id = this.path.toClean(raw)
			if (seen.has(id)) continue
			seen.add(id)
			queue.push(id)
		}
		if (!queue.length) return
		let cursor = 0
		const workerCount = Math.min(PREFETCH_CONCURRENCY, queue.length)
		const worker = async () => {
			while (true) {
				const index = cursor++
				if (index >= queue.length) break
				const id = queue[index]
				const end = this.timing.start('transform', id)
				try {
					await this.vns.fetchModule(id)
				} catch {
					// 某些非代码资源或边缘情况：忽略预取失败，不影响后续 evaluate
				}
				end()
			}
		}
		await Promise.all(Array.from({ length: workerCount }, () => worker()))
	}

	/* ------------------------------ 批处理主流程 ------------------------------ */

	private async processBatch(files: string[], epoch: number) {
		const endBatch = startTimer()
		this.timing.clear()
		this.anchorCache.clear()
		this.ctx.logger.info('[HMR#%d] begin: %d files', epoch, files.length)

		this.logBatchList('changed files', files)

		const graph = this.collectBatchGraph(files)
		this.logGraphDebug(graph)

		this.pruneMissingModules(files)
		this.invalidateCaches(graph.affectedIds)

		const targets = this.pickTargetsByAnchors(
			graph.affectedIds,
			graph.rootsAll,
			this.ctx.loader.pathAnchors,
		)

		this.logBatchList('targets', targets)

		const prefetchList = this.buildPrefetchPlan(targets, graph)
		if (prefetchList.length) {
			await this.prefetchTransforms(prefetchList)
		}

		// 6) 执行入口（按距离近→远）
		const execOrder = this.buildPrefetchList(
			new Set(targets),
			graph.distance,
			'near',
			targets.length || 1,
		)
		await this.runAndLoadAll(execOrder, /*keepOrder*/ true)

		// 7) 观测输出
		this.ctx.logger.info(
			formatAttributionReport({
				changed: files[0] ?? 'N/A',
				targets: execOrder,
				timing: this.timing,
				prettyId: (id) => this.path.pretty(id),
			}),
		)
		const activeServices = this.ctx.registry.container?.services.size ?? 0
		this.ctx.logger.info(
			'[HMR#%d] end: %d services, %sms',
			epoch,
			activeServices,
			endBatch().toFixed(1),
		)
	}
}
