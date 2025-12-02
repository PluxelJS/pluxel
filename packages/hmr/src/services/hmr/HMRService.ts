import { type Context, Injectable } from '@pluxel/core'
import { makeIdFiltersToMatchWithQuery } from '@rolldown/pluginutils'
import { enable as enableDebug } from 'obug'
import { resolve } from 'pathe'
import {
	createFilter,
	createServer,
	type InlineConfig,
	type ModuleNode,
	normalizePath,
	type Plugin,
	type ViteDevServer,
} from 'vite'
import { ModuleCacheMap, ViteNodeRunner } from 'vite-node/client'
import { ViteNodeServer } from 'vite-node/server'
import { installSourcemapsSupport } from 'vite-node/source-map'
import tsconfigPaths from 'vite-tsconfig-paths'
import { configSourcePlugin } from '@pluxel/rolldown'
import {
	type HMRDependencyConfig,
	type ResolvedHMRDependencyConfig,
	resolveHMRDependencyConfig,
} from './config'
import {
	createHmrDebug,
	type HMRLogConfig,
	type ResolvedHMRLogConfig,
	resolveHmrLogConfig,
	toDebugNamespaceString,
} from './logging'

/* -------------------------------- 配置项 -------------------------------- */

export interface HMRConfig {
	/** 业务扫描边界：仅这些目录下的 .ts/.tsx 会被纳入 HMR 入口挑选 */
	dir: string[]
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

const serviceName = 'hmrService' as const
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

const nsToMs = (ns: bigint) => Number(ns) / 1e6
type NumMap = Map<string, number>
const bump = (m: NumMap, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v)
const unique = <T>(iter: Iterable<T>) => Array.from(new Set(iter))

/** 简单计时器，返回结束函数 */
const startTimer = () => {
	const t0 = process.hrtime.bigint()
	return () => nsToMs(process.hrtime.bigint() - t0)
}

/** 轻量互斥，确保批处理串行执行 */
class Mutex {
	private q = Promise.resolve()
	run<T>(fn: () => Promise<T>): Promise<T> {
		const next = this.q.then(fn, fn)
		this.q = next.then(
			() => {},
			() => {},
		)
		return next
	}
}

/** 批处理防抖器：支持 debounce / maxWait / maxBatch 限制 */
class BatchDebouncer {
	private pending = new Set<string>()
	private t: NodeJS.Timeout | null = null
	private tMax: NodeJS.Timeout | null = null
	private epoch = 0
	constructor(
		private flushFn: (files: string[], epoch: number) => Promise<void>,
		private debounceMs: number,
		private maxWaitMs: number,
		private maxBatchFiles: number,
	) {}
	push(id: string) {
		this.pending.add(id)
		if (!this.t) this.t = setTimeout(() => this.flush('debounce'), this.debounceMs)
		if (!this.tMax) this.tMax = setTimeout(() => this.flush('maxwait'), this.maxWaitMs)
		if (this.pending.size >= this.maxBatchFiles) this.flush('maxbatch')
	}
	private async flush(_reason: 'debounce' | 'maxwait' | 'maxbatch') {
		if (!this.pending.size) return
		if (this.t) {
			clearTimeout(this.t)
			this.t = null
		}
		if (this.tMax) {
			clearTimeout(this.tMax)
			this.tMax = null
		}
		const files = [...this.pending]
		this.pending.clear()
		const epoch = ++this.epoch
		await this.flushFn(files, epoch)
	}
}

type TimingBucket = 'transform' | 'evaluate' | 'inject'

/** obug 驱动的计时收集：统一记录 transform/evaluate/inject。 */
class TimingTracker {
	private readonly debugEntry
	private readonly buckets: Record<TimingBucket, NumMap> = {
		transform: new Map<string, number>(),
		evaluate: new Map<string, number>(),
		inject: new Map<string, number>(),
	}

	constructor(
		private readonly options: {
			useColors: boolean
			formatId: (id: string) => string
		},
	) {
		this.debugEntry = createHmrDebug('pluxel:hmr:time:entry', options.useColors)
	}

	clear() {
		for (const bucket of Object.values(this.buckets)) bucket.clear()
	}

	start(kind: TimingBucket, id: string) {
		const t0 = process.hrtime.bigint()
		return () => {
			const durationMs = nsToMs(process.hrtime.bigint() - t0)
			this.record(kind, id, durationMs)
			return durationMs
		}
	}

	record(kind: TimingBucket, id: string, durationMs: number) {
		bump(this.buckets[kind], id, durationMs)
		if (this.debugEntry.enabled) {
			const total = this.buckets[kind].get(id) ?? durationMs
			// 使用 %t 格式化器高亮时间，%p 高亮路径
			this.debugEntry('%s %p %t (agg=%t)', kind, this.options.formatId(id), durationMs, total)
		}
	}

	top(kind: TimingBucket, n = 5) {
		return [...this.buckets[kind].entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
	}

	snapshot() {
		return {
			transformMs: this.buckets.transform,
			evalMs: this.buckets.evaluate,
			injectMs: this.buckets.inject,
		}
	}
}

/** 归一化 moduleCache key，避免 /@fs/ 与根相对路径重复执行。 */
class NormalizedModuleCacheMap extends ModuleCacheMap {
	constructor(private readonly normalize: (id: string) => string) {
		super()
	}

	override normalizePath(fsPath: string): string {
		return this.normalize(fsPath)
	}
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
	private filter!: (id: string) => boolean
	private readonly moduleCache = new NormalizedModuleCacheMap((id) => this.toCleanId(id))
	private serverRoot = ''

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

	constructor(
		private ctx: Context,
		private config: HMRConfig,
	) {
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
			formatId: (id) => this.prettyId(id),
		})

		// 可选开启 obug namespace（否则遵循 DEBUG 环境变量）
		const ns = toDebugNamespaceString(this.logConfig.debugNamespaces)
		if (ns) enableDebug(ns)

		// include .ts/.tsx；排除 .d.ts（兼容 ?v= 查询串）
		const includeGlobs = makeIdFiltersToMatchWithQuery(
			this.config.dir.flatMap((d) => [resolve(d, '**/*.{ts,tsx}')]),
		)
		const excludeGlobs = makeIdFiltersToMatchWithQuery(
			this.config.dir.flatMap((d) => [resolve(d, '**/*.d.ts')]),
		)
		this.filter = createFilter(includeGlobs, excludeGlobs)

		this.plugin = {
			name: 'pluxel-runner',
			apply: 'serve',

			/** DevServer 生命周期：桥接 vite-node、预热业务代码、注册监听 */
			configureServer: async (server) => {
				this.vite = server
				this.serverRoot = this.toViteId(server.config.root)

				// 1) vite-node 服务端（transform/依赖判定交给 vite）
				this.vns = new ViteNodeServer(server, {
					transformMode: { ssr: [/\.([cm]?tsx?|jsx?)$/] },
					deps: {
						external: Array.from(this.deps.runnerExternal),
					},
				})

				// 2) 源映射
				installSourcemapsSupport({ getSourceMap: (src) => this.vns.getSourceMap(src) })

				// 3) 运行器：包裹 fetch 以记录 transform 耗时（命中缓存会是极小值）
				this.runner = new ViteNodeRunner({
					root: server.config.root,
					base: server.config.base,
					moduleCache: this.moduleCache,
					fetchModule: async (id) => {
						const clean = this.toCleanId(id)
						const end = this.timing.start('transform', clean)
						const result = await this.vns.fetchModule(id) // transform on demand
						end()
						return result
					},
					resolveId: (id, importer) => this.vns.resolveId(id, importer),
				})

				// 4) 把需要保持单例的工作区模块塞进 moduleCache
				await this.bridgeWorkspaceModules(this.deps.bridgeModules)

				// 5) 批处理器
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
				)

				// 6) FS 监听：add/unlink 也纳入批处理（锚点新增/清理）
				server.watcher.on('add', (file) => {
					if (this.filter(file)) this.debouncer.push(this.toCleanId(file))
				})
				server.watcher.on('unlink', (file) => {
					if (this.filter(file)) this.debouncer.push(this.toCleanId(file))
				})

				// 7) 冷启动：扫描 + 预热执行（让 loader 完成 anchors 首次填充）
				const endScan = startTimer()
				const scanRoots = this.config.dir.map((d) => resolve(process.cwd(), d))
				const files = await this.ctx.scanService.scanEntries({
					roots: scanRoots,
					scan: { preferHmrExports: true, fallbackTsOnSingle: true },
				})
				this.ctx.logger.info('[HMR] scan: %d files in %sms', files.length, endScan().toFixed(1))

				const endWarmup = startTimer()
				const coldFiles = unique(files.map((p) => this.toCleanId(p))).sort()

				// 详细输出预热文件列表（需 DEBUG=pluxel:hmr:warmup）
				if (this.dbg.warmup.enabled) {
					this.dbg.warmup(
						'files (%n): %l',
						coldFiles.length,
						coldFiles.map((f) => this.prettyId(f)),
					)
				}

				await this.runAndLoadAll(coldFiles, /*keepOrder*/ true)
				this.ctx.logger.info(
					'[HMR] warmup: %d files in %sms',
					coldFiles.length,
					endWarmup().toFixed(1),
				)
			},

			/** 服务端 HMR：仅入队，由批处理串行执行 */
			handleHotUpdate: async (ctx0) => {
				if (!this.filter(ctx0.file)) return []
				this.debouncer.push(this.toCleanId(ctx0.file))
				return [] // 服务端 HMR 由我们全权处理
			},
		}
	}

	public get moduleCacheMap(): ModuleCacheMap {
		return this.moduleCache
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
			const cleanId = this.toCleanId(rawId)
			this.moduleCache.set(cleanId, { ...cacheEntry })
		}
	}

	/** Remove module cache mappings for a set of ids (any alias form is accepted). */
	public dropModuleCacheEntries(ids: Iterable<string>) {
		for (const rawId of ids) {
			const cleanId = this.toCleanId(rawId)
			this.moduleCache.delete(cleanId)
		}
	}

	/* --------------------------- 路径规范化工具 --------------------------- */

	/** 生成常见等价 ID（绝对、/@fs、根相对），用于查 graph 与缓存 */
	private moduleIdVariants(pOrId: string): string[] {
		const canonical = this.toCleanId(pOrId)
		const variants = new Set<string>([canonical])

		if (canonical.startsWith('/')) {
			variants.add(`/@fs${canonical}`)
			if (this.serverRoot && canonical.startsWith(this.serverRoot)) {
				const rel = canonical.slice(this.serverRoot.length)
				const relWithSlash = rel.startsWith('/') ? rel : `/${rel}`
				variants.add(relWithSlash)
			}
		}

		return [...variants]
	}

	private toViteId(p: string) {
		return normalizePath(p) // Windows \ → /；保持与 vite graph 一致
	}
	private cleanUrl(id: string) {
		const i = id.indexOf('?') // 去除 ?v= / ?import 变体
		return i >= 0 ? id.slice(0, i) : id
	}
	private toCleanId(pOrId: string) {
		const clean = this.cleanUrl(this.toViteId(pOrId))
		// 1) Vite 内部访问文件系统会加 /@fs/ 前缀
		let normalized = clean.replace(/^\/@fs\//, '/')
		// 2) 处理 dev server 根相对的路径（/tests/...）
		if (this.serverRoot && normalized.startsWith('/') && !normalized.startsWith(this.serverRoot)) {
			normalized = normalizePath(resolve(this.serverRoot, normalized.slice(1)))
		}
		return normalized
	}
	private prettyId(pOrId: string) {
		const clean = this.toCleanId(pOrId)
		const cwd = this.toViteId(process.cwd())
		if (clean.startsWith(cwd)) return clean.slice(cwd.length).replace(/^\\\//, '')
		return clean
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

		const dedup = unique(filesPath.map((p) => this.toCleanId(p)))
		const ordered = keepOrder ? dedup : [...dedup]

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
				hasPlugin = await this.ctx.loader.replaceModule(id, mod)
			} catch (err) {
				this.ctx.logger.error({ file: id, err }, '[HMR] replaceModule failed')
				continue
			}
			const injectMs = endInject()

			// 使用格式化器：%p 路径高亮，%t 时间高亮，%b 布尔高亮
			this.dbg.modules(
				'execute %p: eval=%t inject=%t plugin=%b',
				this.prettyId(id),
				evaluateMs,
				injectMs,
				hasPlugin,
			)
		}

		const endCommit = startTimer()
		const res = await this.ctx.registry.commit()
		this.ctx.logger.info('[HMR] commit: %sms', endCommit().toFixed(1))

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
				const ids = new Set<string>([specifier, resolved1.id, this.toCleanId(resolved1.id)])

				const resolved2 = await this.vns.resolveId(resolved1.id)
				if (resolved2?.id) {
					ids.add(resolved2.id)
					ids.add(this.toCleanId(resolved2.id))
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
		const serverConfig: InlineConfig = {
			root: process.cwd(),
			server: { port: 3000, middlewareMode: false },
			resolve: {},
			plugins: [
				tsconfigPaths(),
				configSourcePlugin({ include: this.config.dir.map((d) => `${d}/**/*.{ts,tsx}`) }),
				this.plugin,
				this.ctx.honoService.viteHonoDevServer,
			],
			// ✅ 真正禁用依赖预优化，以免 graph 形变
			optimizeDeps: {
				force: true, // 避免某些场景下跳过预优化
				include: Array.from(this.deps.optimizeDepsInclude),
				// 某些 CJS 包需要命名导出映射时的兜底（视实际需要开启）
				needsInterop: Array.from(this.deps.optimizeDepsInterop),
			},
			ssr: {
				// 避免把 react/react-dom external 掉，交给 Vite 处理更一致
				noExternal: Array.from(this.deps.ssrNoExternal),
				external: Array.from(this.deps.ssrExternal), // 只保留你必须 external 的
			},
		}
		const server = await createServer(serverConfig)
		await server.listen()
		server.printUrls()
		this.ctx.logger.info(`HMR 服务已启动，只监听：${this.config.dir.join(', ')}`)
	}

	/* --------------------------- Graph / 受影响子图 --------------------------- */

	/** 从 FS 路径拿到 graph 模块节点（兼容 byFile / byId 两支） */
	private getModulesByFile(fileOrId: string) {
		for (const variant of this.moduleIdVariants(fileOrId)) {
			const byFile = this.vite.moduleGraph.getModulesByFile(variant)
			if (byFile?.size) return [...byFile]
		}
		for (const variant of this.moduleIdVariants(fileOrId)) {
			const single = this.vite.moduleGraph.getModuleById(variant)
			if (single) return [single]
		}
		return []
	}

	/**
	 * 受影响收集（仅业务边界）
	 * - 自底向上沿 importers 递归，将命中 this.filter 且非虚拟模块(\0) 的节点纳入
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
			const id = this.toCleanId(m.id)
			if (!this.filter(id) || id.startsWith('\0')) continue
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
				(im) => im.id && affectedIds.has(this.toCleanId(im.id)),
			)
			if (!hasImporterInside) roots.push(id)
		}

		return { affectedIds, roots, distance }
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
		for (const a of pathAnchors) anchorSet.add(this.toCleanId(a))

		const targets = new Set<string>()
		let needFallbackRoots = false

		for (const id of affectedIds) {
			const anchor = this.findNearestPluginAnchor(id, anchorSet)
			if (anchor) targets.add(anchor)
			else needFallbackRoots = true
		}

		if (needFallbackRoots) for (const r of rawRoots) targets.add(this.toCleanId(r))
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
			const id = this.toCleanId(m.id)
			if (visited.has(id)) continue
			visited.add(id)

			if (!this.filter(id) || id.startsWith('\0')) continue

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
			for (const variant of this.moduleIdVariants(id)) {
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
			const base = this.toCleanId(key)
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
					invalidatedKeys.map((k) => this.prettyId(k)),
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

	/** 仅 transform，不 evaluate；把账记到每个受影响文件 */
	private async prefetchTransforms(ids: Iterable<string>) {
		const seen = new Set<string>()
		for (const raw of ids) {
			const id = this.toCleanId(raw)
			if (seen.has(id)) continue
			seen.add(id)
			const end = this.timing.start('transform', id)
			try {
				await this.vns.fetchModule(id)
			} catch {
				// 某些非代码资源或边缘情况：忽略预取失败，不影响后续 evaluate
			}
			end()
		}
	}

	/* ------------------------------ 观测输出 ------------------------------ */

	/** 格式化 top 排名 */
	private formatTopEntries(
		entries: Array<[string, number]>,
		marker?: (id: string) => string | undefined,
	): string {
		if (!entries.length) return '    (none)'
		return entries
			.map(([id, ms], i) => {
				const tag = marker?.(id)
				const suffix = tag ? ` [${tag}]` : ''
				return `    ${i + 1}. ${this.prettyId(id)} ${ms.toFixed(1)}ms${suffix}`
			})
			.join('\n')
	}

	private printAttribution(changed: string, _affectedIds: Set<string>, targets: string[]) {
		const targetSet = new Set(targets)
		const marker = (id: string) =>
			targetSet.has(id) ? 'target' : id === changed ? 'changed' : undefined

		const transformTop = this.timing.top('transform', 5)
		const evaluateTop = this.timing.top('evaluate', 3)
		const injectTop = this.timing.top('inject', 3)

		const lines = [
			`[HMR] attribution: ${this.prettyId(changed)} → ${targets.length} targets`,
			'  transform:',
			this.formatTopEntries(transformTop, marker),
			'  evaluate:',
			this.formatTopEntries(evaluateTop),
			'  inject:',
			this.formatTopEntries(injectTop),
		]
		this.ctx.logger.info(lines.join('\n'))
	}

	/* ------------------------------ 批处理主流程 ------------------------------ */

	private async processBatch(files: string[], epoch: number) {
		const endBatch = startTimer()
		this.timing.clear()
		this.anchorCache.clear()
		this.ctx.logger.info('[HMR#%d] begin: %d files', epoch, files.length)

		// 详细输出触发文件（需 DEBUG=pluxel:hmr:batch）
		if (this.dbg.batch.enabled) {
			this.dbg.batch(
				'changed files (%n): %l',
				files.length,
				files.map((f) => this.prettyId(f)),
			)
		}

		// 1) 合并受影响子图（多起点）
		const affectedIds = new Set<string>()
		const rootsAll: string[] = []
		const distance = new Map<string, number>()
		for (const f of files) {
			const { affectedIds: a, roots, distance: dist } = this.collectAffected(f)
			for (const id of a) {
				affectedIds.add(id)
			}
			rootsAll.push(...roots)
			dist.forEach((d, id) => {
				const prev = distance.get(id)
				if (prev === undefined || d < prev) distance.set(id, d)
			})
		}

		// 详细输出受影响子图（需 DEBUG=pluxel:hmr:graph）
		if (this.dbg.graph.enabled) {
			const affectedList = [...affectedIds].map((id) => {
				const d = distance.get(id) ?? -1
				return `${this.prettyId(id)} (d=${d})`
			})
			this.dbg.graph('affected (%n): %l', affectedIds.size, affectedList)
			this.dbg.graph(
				'roots (%n): %l',
				rootsAll.length,
				rootsAll.map((r) => this.prettyId(r)),
			)
		}

		// 2) 针对 unlink 的清理：不在图内的直接注销并清锚点
		for (const f of files) {
			const mods = this.vite.moduleGraph.getModulesByFile(f)
			const exists = mods?.size || this.vite.moduleGraph.getModuleById(f)
			if (!exists) {
				this.ctx.loader.pathAnchors.delete(f)
				this.ctx.loader.pruneModule(f)
			}
		}

		// 3) 缓存失效（Vite + vite-node）
		this.invalidateCaches(affectedIds)

		// 4) 最近锚点挑选（不可达则回退 roots）
		const targets = this.pickTargetsByAnchors(affectedIds, rootsAll, this.ctx.loader.pathAnchors)

		// 详细输出 targets（需 DEBUG=pluxel:hmr:batch）
		if (this.dbg.batch.enabled) {
			this.dbg.batch(
				'targets (%n): %l',
				targets.length,
				targets.map((t) => this.prettyId(t)),
			)
		}

		// 5) 预取 transform（优先只对将执行的 targets；为空则回落 affectedIds）
		if ((this.config.attribution ?? 'prefetch') === 'prefetch') {
			const limit = this.config.prefetchLimit ?? DEFAULT_PREFETCH_LIMIT
			const order = this.config.prefetchOrder ?? 'near'
			const base = targets.length ? new Set(targets) : affectedIds
			const prefetchList = this.buildPrefetchList(base, distance, order, limit)
			await this.prefetchTransforms(prefetchList)
		}

		// 6) 执行入口（按距离近→远）
		const execOrder = this.buildPrefetchList(
			new Set(targets),
			distance,
			'near',
			targets.length || 1,
		)
		await this.runAndLoadAll(execOrder, /*keepOrder*/ true)

		// 7) 观测输出
		this.printAttribution(files[0] ?? 'N/A', affectedIds, execOrder)
		const activeServices = this.ctx.registry.pluginRegistry.lastContainer?.services.size ?? 0
		this.ctx.logger.info(
			'[HMR#%d] end: %d services, %sms',
			epoch,
			activeServices,
			endBatch().toFixed(1),
		)
	}
}
