import { type Context, Injectable } from '@pluxel/core'
import type { LoggerService, PluginService } from '@pluxel/core/services'
import { makeIdFiltersToMatchWithQuery } from '@rolldown/pluginutils'
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
import {
	type HMRDependencyConfig,
	type ResolvedHMRDependencyConfig,
	resolveHMRDependencyConfig,
} from './config'

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
	private readonly moduleCache = new ModuleCacheMap()

	/** 依赖/模块行为：external、bridge、optimizeDeps 等 */
	private readonly deps: ResolvedHMRDependencyConfig

	private plugin!: Plugin

	/** 计时器：一轮 HMR 内聚合 */
	private trace = {
		transformMs: new Map<string, number>() as NumMap,
		evalMs: new Map<string, number>() as NumMap,
		injectMs: new Map<string, number>() as NumMap,
		clear() {
			this.transformMs.clear()
			this.evalMs.clear()
			this.injectMs.clear()
		},
	}

	/** 串行互斥 + 防抖出批 */
	private mutex = new Mutex()
	private debouncer!: BatchDebouncer

	/** 最近锚点缓存（按批清空，批内复用） */
	private anchorCache = new Map<string, string | null>()

	constructor(
		private ctx: Context,
		private config: HMRConfig,
	) {
		this.deps = resolveHMRDependencyConfig(this.config.deps)

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
						const t0 = process.hrtime.bigint()
						const r = await this.vns.fetchModule(id) // transform on demand
						const t1 = process.hrtime.bigint()
						bump(this.trace.transformMs, clean, nsToMs(t1 - t0))
						return r
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
				console.time('[HMR] 扫描文件')
				const files = await this.ctx.scanService.scanEntries({ roots: this.config.dir })
				console.timeEnd('[HMR] 扫描文件')

				console.time('[HMR] 预热/执行模块')
				const coldFiles = unique(files.map((p) => this.toCleanId(p))).sort()
				await this.runAndLoadAll(coldFiles, /*keepOrder*/ true)
				console.timeEnd('[HMR] 预热/执行模块')
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

	private toViteId(p: string) {
		return normalizePath(p) // Windows \ → /；保持与 vite graph 一致
	}
	private cleanUrl(id: string) {
		const i = id.indexOf('?') // 去除 ?v= / ?import 变体
		return i >= 0 ? id.slice(0, i) : id
	}
	private toCleanId(pOrId: string) {
		return this.cleanUrl(this.toViteId(pOrId))
	}

	/* ------------------------------ 执行 + 注入 ------------------------------ */

	/**
	 * 逐入口执行 + 交给 loader 注入（replaceModule）
	 * - 顺序执行以保证副作用时序稳定
	 * - 计时：evaluate（入口执行）与 inject（注册/注入）
	 * - 失败隔离：单入口失败不阻断整批；最终 commit 一次
	 */
	private async runAndLoadAll(filesPath: string[], keepOrder = true) {
		if (!filesPath.length) return

		const dedup = unique(filesPath.map((p) => this.toCleanId(p)))
		const ordered = keepOrder ? dedup : [...dedup]

		for (const id of ordered) {
			const t0 = process.hrtime.bigint()
			let mod: any
			try {
				mod = await this.runner.executeFile(id) // Evaluate 入口
			} catch (err) {
				this.ctx.logger.error({ file: id, err }, '[HMR] execute failed')
				continue
			}
			const t1 = process.hrtime.bigint()

			let hasPlugin = false
			try {
				hasPlugin = this.ctx.loader.replaceModule(id, mod)
			} catch (err) {
				this.ctx.logger.error({ file: id, err }, '[HMR] replaceModule failed')
				continue
			}
			const t2 = process.hrtime.bigint()

			const evaluateMs = nsToMs(t1 - t0)
			const injectMs = nsToMs(t2 - t1)
			bump(this.trace.evalMs, id, evaluateMs)
			bump(this.trace.injectMs, id, injectMs)

			this.ctx.logger.info(
				{ file: id, timings: { evaluateMs, loadModuleMs: injectMs }, pluginEntry: hasPlugin },
				'[HMR] execute module',
			)
		}

		const tc0 = process.hrtime.bigint()
		const res = await this.ctx.registry.commit()
		const tc1 = process.hrtime.bigint()
		this.ctx.logger.info({ durationMs: nsToMs(tc1 - tc0) }, '[HMR] registry.commit()')

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
			resolve: {
				alias: [
					{
						// 3.34.1 的 tabler icons ESM 单体导出，避免切片数过多
						find: '@tabler/icons-react',
						replacement: '@tabler/icons-react/dist/esm/icons/index.mjs',
					},
				],
			},
			plugins: [tsconfigPaths(), this.plugin, this.ctx.honoService.viteHonoDevServer],
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
		const id = this.toCleanId(fileOrId)
		const byFile = this.vite.moduleGraph.getModulesByFile(id)
		if (byFile?.size) return [...byFile]
		const single = this.vite.moduleGraph.getModuleById(id)
		return single ? [single] : []
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
			const id = this.cleanUrl(m.id)
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
				(im) => im.id && affectedIds.has(this.cleanUrl(im.id)),
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
			const id = this.cleanUrl(m.id)
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

		// 1) 失效 Vite 的 transform/ssr 缓存
		for (const id of affectedIds) {
			const mods = g.getModulesByFile(id)
			if (mods?.size) {
				for (const m of mods) g.invalidateModule(m)
			} else {
				const m = g.getModuleById(id)
				if (m) g.invalidateModule(m)
			}
		}

		// 2) 失效 vite-node 执行缓存（清理所有查询后缀的等价 key）
		for (const key of this.moduleCache.keys()) {
			const base = this.cleanUrl(key)
			if (affectedIds.has(base)) this.moduleCache.delete(key)
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
			const t0 = process.hrtime.bigint()
			try {
				await this.vns.fetchModule(id)
			} catch {
				// 某些非代码资源或边缘情况：忽略预取失败，不影响后续 evaluate
			}
			const t1 = process.hrtime.bigint()
			bump(this.trace.transformMs, id, nsToMs(t1 - t0))
		}
	}

	/* ------------------------------ 观测输出 ------------------------------ */

	private topN(m: NumMap, n = 5) {
		return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
	}

	private printAttribution(
		changed: string,
		_affectedd: Set<string>,
		targets: string[],
		extra?: {
			prefetchCandidates?: number
		},
	) {
		const targetSet = new Set(targets)

		const report: Record<string, unknown> = {
			changed,
			targets: [...targetSet],
			metrics: {
				prefetchCandidates: extra?.prefetchCandidates ?? targets.length,
			},
		}
		if (this.trace.transformMs.size) {
			report.transformTop = this.topN(this.trace.transformMs).map(([id, ms]) => ({
				id,
				durationMs: ms,
				marker: targetSet.has(id) ? 'target' : id === changed ? 'changed' : undefined,
			}))
		}
		if (this.trace.evalMs.size) {
			report.evaluateTop = this.topN(this.trace.evalMs, 3).map(([id, ms]) => ({
				id,
				durationMs: ms,
			}))
		}
		if (this.trace.injectMs.size) {
			report.injectTop = this.topN(this.trace.injectMs, 3).map(([id, ms]) => ({
				id,
				durationMs: ms,
			}))
		}

		this.ctx.logger.info(report, '[HMR] timing attribution')
	}

	/* ------------------------------ 批处理主流程 ------------------------------ */

	private async processBatch(files: string[], epoch: number) {
		const stamp = `[HMR#${epoch}]`
		this.trace.clear()
		this.anchorCache.clear()
		this.ctx.logger.info({ files }, `${stamp} begin`)

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
		this.printAttribution(files[0] ?? 'N/A', affectedIds, execOrder, {
			prefetchCandidates: targets.length ? targets.length : affectedIds.size,
		})
		const activeServices = this.ctx.registry.pluginRegistry.lastContainer.services.size
		this.ctx.logger.info({ activeServices }, `${stamp} end`)
	}
}
