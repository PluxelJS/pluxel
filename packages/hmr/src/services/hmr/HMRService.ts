import { type Context, Injectable } from '@pluxel/core'
import { resolve } from 'pathe'
import swc from 'unplugin-swc'
import {
	createFilter,
	createServer,
	type ModuleNode,
	normalizePath,
	type Plugin,
	type ViteDevServer,
} from 'vite'
import { ViteNodeRunner } from 'vite-node/client'
import { ViteNodeServer } from 'vite-node/server'
import { installSourcemapsSupport } from 'vite-node/source-map'
import tsconfigPaths from 'vite-tsconfig-paths'

/* -------------------------------- 配置项 -------------------------------- */

interface HMRConfig {
	/** 业务扫描边界：仅这些目录下的 .ts/.tsx 会被纳入 HMR 入口挑选 */
	dir: string[]
	/** 计时归因策略：'off' 关闭预取归因，仅保留 evaluate/inject；'prefetch' 预取受影响文件做 transform 计时（默认） */
	attribution?: 'off' | 'prefetch'
	/** 预取上限：避免超大变更范围引发 storm（默认 200） */
	prefetchLimit?: number
	/** 预取排序策略：'near' 按与变更点的上行距离从近到远（默认）；'all' 仅按字典序 */
	prefetchOrder?: 'near' | 'all'
}

/* --------------------------------- 常量 --------------------------------- */

const DEFAULT_PREFETCH_LIMIT = 200

const serviceName = 'hmrService' as const
declare module '@pluxel/core' {
	interface Context {
		[serviceName]: HMRService
	}
}

/* --------------------------------- 工具 --------------------------------- */

const nsToMs = (ns: bigint) => Number(ns) / 1e6
type NumMap = Map<string, number>
const bump = (m: NumMap, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v)

/* ------------------------------ HMR Service ----------------------------- */
/**
 * HMRService（anchors 实时读取 + 计时归因版）
 * - 不镜像 loader 状态；实时读取 this.ctx.loader.pathAnchors（SSOT）
 * - 统一 cleanId（POSIX + 去查询串）以对齐 moduleGraph / anchors
 * - 计时拆账：transform（预取）/ evaluate（入口）/ inject（loadFileModule）
 */
@Injectable({ key: serviceName })
export class HMRService {
	private vite!: ViteDevServer
	private vns!: ViteNodeServer
	private runner!: ViteNodeRunner
	private filter!: (id: string) => boolean

	/** SWC：装饰器/TSX/源映射，紧贴你的现有链路 */
	private swc = swc.vite({
		sourceMaps: true,
		jsc: {
			parser: { syntax: 'typescript', decorators: true, tsx: true },
			transform: {
				legacyDecorator: true,
				decoratorMetadata: true,
				react: { runtime: 'automatic', refresh: true },
			},
		},
	}) as unknown as Plugin

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

	constructor(
		private ctx: Context,
		private config: HMRConfig,
	) {
		const includeGlobs = config.dir.map((d) => resolve(d, '**/*.ts'))
		this.filter = createFilter(includeGlobs)

		this.plugin = {
			name: 'pluxel-runner',
			apply: 'serve',

			/** DevServer 生命周期：桥接 vite-node、预热业务代码 */
			configureServer: async (server) => {
				this.vite = server

				// 1) vite-node 服务端（transform/依赖判定交给 vite）
				this.vns = new ViteNodeServer(server, {
					transformMode: { ssr: [/\.([cm]?tsx?|jsx?)$/] },
					deps: {
						// 大型稳定三方 external，减少 transform 压力
						external: [/^(react|react-dom|lodash|dayjs)(\/|$)/],
					},
				})

				// 2) 源映射交由 vite-node
				installSourcemapsSupport({ getSourceMap: (src) => this.vns.getSourceMap(src) })

				// 3) 运行器：包裹 fetch 以记录 transform 耗时（命中缓存会是极小值）
				this.runner = new ViteNodeRunner({
					root: server.config.root,
					base: server.config.base,
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

				// 4) 冷启动：扫描 + 预热执行（让 loader 完成 anchors 首次填充）
				console.time('[HMR] 扫描文件')
				const files = await this.ctx.scanService.scan(this.config.dir)
				console.timeEnd('[HMR] 扫描文件')

				console.time('[HMR] 预热/执行模块')
				await this.runAndLoadAll(files)
				console.timeEnd('[HMR] 预热/执行模块')
			},

			/** 服务端 HMR：失效缓存 →（可选）预取 transform → 锚点执行 */
			handleHotUpdate: async (ctx0) => {
				if (!this.filter(ctx0.file)) return
				this.trace.clear()

				const changed = this.toCleanId(ctx0.file)
				this.ctx.logger.info(`[HMR] Reload due to ${changed}`)

				// 1) 受影响收集（只在业务边界内向上）
				const { affectedIds, roots, distance } = this.collectAffected(changed)

				// 2) 统一失效缓存（Vite graph + vite-node 执行缓存）
				this.invalidateCaches(affectedIds)

				// 3) （可选）预取 transform，归因到受影响文件；限流 & 排序
				if ((this.config.attribution ?? 'prefetch') === 'prefetch') {
					const limit = this.config.prefetchLimit ?? DEFAULT_PREFETCH_LIMIT
					const order = this.config.prefetchOrder ?? 'near'
					const prefetchList = this.buildPrefetchList(affectedIds, distance, order, limit)
					await this.prefetchTransforms(prefetchList)
				}

				// 4) 读“实时 anchors”，挑选最近锚点作为执行入口（无锚点支路回退 roots）
				const targets = this.pickTargetsByAnchors(affectedIds, roots, this.ctx.loader.pathAnchors)

				// 5) 顺序执行入口 + 注入（保持副作用时序）
				await this.runAndLoadAll(targets)

				// 6) 观测与榜单
				this.printAttribution(changed, affectedIds, targets)
				this.ctx.logger.info(this.ctx.registry.pluginRegistry.lastContainer.services.size)

				return [] // 服务端 HMR 由我们全权处理
			},
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
	 * 逐入口执行 + 交给 loader 注入（loadFileModule）
	 * - 顺序执行以保证副作用时序稳定
	 * - 计时：evaluate（入口执行）与 inject（注册/注入）
	 */
	private async runAndLoadAll(filesPath: string[]) {
		if (!filesPath.length) return

		const unique = Array.from(new Set(filesPath.map((p) => this.toCleanId(p)))).sort()
		for (const id of unique) {
			const t0 = process.hrtime.bigint()
			const mod = await this.runner.executeFile(id) // Evaluate 入口
			const t1 = process.hrtime.bigint()

			const hasPlugin = this.ctx.loader.loadFileModule(id, mod)
			const t2 = process.hrtime.bigint()

			bump(this.trace.evalMs, id, nsToMs(t1 - t0))
			bump(this.trace.injectMs, id, nsToMs(t2 - t1))

			this.ctx.logger.info(
				`[HMR] 执行: ${id}\n` +
					`  • evaluate(entrance): ${nsToMs(t1 - t0).toFixed(2)}ms\n` +
					`  • loadFileModule:     ${nsToMs(t2 - t1).toFixed(2)}ms` +
					(hasPlugin ? '\n  • 插件入口: yes' : ''),
			)
		}

		const tc0 = process.hrtime.bigint()
		const res = await this.ctx.registry.commit()
		const tc1 = process.hrtime.bigint()
		this.ctx.logger.info(`[HMR] registry.commit(): ${nsToMs(tc1 - tc0).toFixed(2)}ms`)

		return res
	}

	/* ------------------------------ DevServer 启动 ------------------------------ */

	public async start(): Promise<void> {
		const server = await createServer({
			root: process.cwd(),
			server: { port: 3000, middlewareMode: false },
			resolve: {
				alias: {
					// 3.34.1 的 tabler icons ESM 单体导出，避免切片数过多
					'@tabler/icons-react': '@tabler/icons-react/dist/esm/icons/index.mjs',
				},
			},
			plugins: [
				tsconfigPaths(),
				this.swc,
				this.plugin, // ← vite-node 桥
				this.ctx.honoService.viteHonoDevServer,
			],
			// SSR 链建议禁用依赖预优化，以免 graph 形变
			optimizeDeps: {},
			ssr: { external: ['react', 'react-dom'] },
		})
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

		while (queue.length) {
			const { m, d } = queue.shift()!
			if (!m?.id) continue
			const id = this.cleanUrl(m.id)
			if (!this.filter(id) || id.startsWith('\0')) continue
			if (visited.has(id)) continue
			visited.add(id)
			affectedIds.add(id)
			idToMod.set(id, m)
			distance.set(id, d)

			// 向上追溯所有 importers（= 依赖“我”的上游）
			for (const importer of m.importers) if (importer?.id) queue.push({ m: importer, d: d + 1 })
		}

		// roots：在集合里没有 importer 仍在集合内的节点
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

		const memo = new Map<string, string | null>()
		const targets = new Set<string>()
		let needFallbackRoots = false

		for (const id of affectedIds) {
			const anchor = this.findNearestPluginAnchor(id, memo, anchorSet)
			if (anchor) targets.add(anchor)
			else needFallbackRoots = true
		}

		if (needFallbackRoots) for (const r of rawRoots) targets.add(this.toCleanId(r))
		return Array.from(targets)
	}

	/** 在受影响子图内，从起点向上 BFS；命中第一个锚点即返回（最短链路） */
	private findNearestPluginAnchor(
		startCleanId: string,
		memo: Map<string, string | null>,
		anchors: Set<string>,
	) {
		if (memo.has(startCleanId)) return memo.get(startCleanId)!

		const visited = new Set<string>()
		const queue: ModuleNode[] = []
		for (const m of this.getModulesByFile(startCleanId)) queue.push(m)

		while (queue.length) {
			const m = queue.shift()!
			if (!m?.id) continue
			const id = this.cleanUrl(m.id)
			if (visited.has(id)) continue
			visited.add(id)

			// 仅在业务边界内移动；\0 虚拟模块跳过
			if (!this.filter(id) || id.startsWith('\0')) continue

			if (anchors.has(id)) {
				memo.set(startCleanId, id)
				return id
			}

			for (const im of m.importers) if (im?.id) queue.push(im)
		}

		memo.set(startCleanId, null)
		return null
	}

	/* ------------------------------ 缓存失效 ------------------------------ */

	/**
	 * 统一失效 Vite transform/SSR 缓存 + vite-node 执行缓存
	 * - 先 graph.invalidate 确保下一步 fetch/execute 拿到最新产物
	 * - 再清 runner.moduleCache（含 ?xxx 变体），避免命中旧执行结果
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
		const keys = Array.from(this.runner.moduleCache.keys())
		for (const key of keys) {
			const base = this.cleanUrl(key)
			if (affectedIds.has(base)) this.runner.moduleCache.delete(key)
		}
	}

	/* ------------------------------ 预取（transform 归因） ------------------------------ */

	/** 组装预取列表：按距离排序并限流；或直接取全部（字典序） */
	private buildPrefetchList(
		affectedIds: Set<string>,
		distance: Map<string, number>,
		order: 'near' | 'all',
		limit: number,
	) {
		const items = [...affectedIds]
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
		const unique = Array.from(new Set([...ids].map((i) => this.toCleanId(i))))
		for (const id of unique) {
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

	private printAttribution(changed: string, affected: Set<string>, targets: string[]) {
		const fmt = (ms: number) => `${ms.toFixed(1)}ms`

		if (this.trace.transformMs.size) {
			this.ctx.logger.info('【Transform Top】(受影响文件)')
			for (const [id, ms] of this.topN(this.trace.transformMs)) {
				const mark = id === changed ? '  ← changed' : targets.includes(id) ? '  ← target' : ''
				this.ctx.logger.info(`  ${fmt(ms)}  ${id}${mark}`)
			}
		}

		if (this.trace.evalMs.size) {
			this.ctx.logger.info('【Evaluate Top】(入口执行)')
			for (const [id, ms] of this.topN(this.trace.evalMs, 3)) {
				this.ctx.logger.info(`  ${fmt(ms)}  ${id}`)
			}
		}

		if (this.trace.injectMs.size) {
			this.ctx.logger.info('【Inject Top】(loadFileModule)')
			for (const [id, ms] of this.topN(this.trace.injectMs, 3)) {
				this.ctx.logger.info(`  ${fmt(ms)}  ${id}`)
			}
		}
	}
}
