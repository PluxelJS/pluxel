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

/** HMR 可配置项：仅限定业务扫描边界，避免整仓库图震荡 */
interface HMRConfig {
	dir: string[]
}

const serviceName = 'hmrService' as const
declare module '@pluxel/core' {
	interface Context {
		[serviceName]: HMRService
	}
}

/**
 * HMRService（anchors 实时读取版）
 * - 不缓存、不镜像 loader 状态；仅在挑选执行目标时读取 this.ctx.loader.pathAnchors
 * - 路径统一 cleanId（POSIX + 去查询串）以对齐 moduleGraph / anchors
 */
@Injectable({ key: serviceName })
export class HMRService {
	private vite!: ViteDevServer
	private vns!: ViteNodeServer
	private runner!: ViteNodeRunner
	private filter!: (id: string) => boolean

	/** SWC：装饰器/TSX/源映射；尽量靠近你的既有链路 */
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

	private plugin: Plugin

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

				// 1) vite-node 服务端（把 transform/依赖判定交给 vite）
				this.vns = new ViteNodeServer(server, {
					transformMode: { ssr: [/\.([cm]?tsx?|jsx?)$/] },
					deps: {
						// 大型稳定三方 external，减少 transform 压力
						external: [/^(react|react-dom|lodash|dayjs)(\/|$)/],
					},
				})

				// 2) 源映射交由 vite-node
				installSourcemapsSupport({ getSourceMap: (src) => this.vns.getSourceMap(src) })

				// 3) 运行器：Node 以 Vite 的方式拉取/执行模块
				this.runner = new ViteNodeRunner({
					root: server.config.root,
					base: server.config.base,
					fetchModule: (id) => this.vns.fetchModule(id),
					resolveId: (id, importer) => this.vns.resolveId(id, importer),
				})

				// 4) 冷启动扫描 + 预热执行（让 loader 完成 anchors 首次填充）
				console.time('[HMR] 扫描文件')
				const files = await this.ctx.scanService.scan(this.config.dir)
				console.timeEnd('[HMR] 扫描文件')

				console.time('[HMR] 预热/执行模块')
				await this.runAndLoadAll(files)
				console.timeEnd('[HMR] 预热/执行模块')
			},

			/** 接管服务端 HMR：精确挑选“最近插件锚点”作为执行入口 */
			handleHotUpdate: async (ctx) => {
				// 非业务边界文件交还给 Vite 默认行为（例如依赖的样式/虚拟模块）
				if (!this.filter(ctx.file)) return

				const changed = this.toCleanId(ctx.file)
				this.ctx.logger.info(`[HMR] Reload due to ${changed}`)

				// 1) 受影响子图（自下而上）+ 传统 roots（兜底）
				const { affectedIds, roots } = this.collectAffected(changed)

				// 2) 统一失效缓存（Vite graph + vite-node 执行缓存）
				this.invalidateCaches(affectedIds)

				// 3) 读“实时 anchors”（SSOT：this.ctx.loader.pathAnchors）
				//    - 这里不做任何快照复制，直接按需查询，确保与 loader 同步
				//    - 若 loader 存的是非 cleanId，这里统一 clean 再比对
				const targets = this.pickTargetsByAnchors(affectedIds, roots, this.ctx.loader.pathAnchors)

				// 4) 只执行必要入口；其间 loader 会更新自身 anchors（我们不碰）
				await this.runAndLoadAll(targets)

				this.ctx.logger.info(this.ctx.registry.pluginRegistry.lastContainer.services.size)
				return [] // 服务端 HMR 由我们全权处理
			},
		}
	}

	// -------------------- 路径规范化工具 --------------------
	private toViteId(p: string) {
		return normalizePath(p) // Windows \ → /；保持与 vite graph 一致
	}
	private cleanUrl(id: string) {
		const i = id.indexOf('?') // 去除 ?v= / ?import 变体，统一比较基线
		return i >= 0 ? id.slice(0, i) : id
	}
	private toCleanId(pOrId: string) {
		return this.cleanUrl(this.toViteId(pOrId))
	}

	// -------------------- 执行+注入 --------------------
	/**
	 * 逐入口执行 + 交给 loader 注入（loadFileModule）
	 * - 顺序执行以保证副作用时序稳定（插件注册通常具全局可见性）
	 * - 若未来要并发：请确保注册幂等且无序相关，再换成 p-limit 控制并发
	 */
	private async runAndLoadAll(filesPath: string[]) {
		if (!filesPath.length) return

		// 去重 + 稳定排序（字典序）：稳定日志与 cache locality 略有好处
		const unique = Array.from(new Set(filesPath.map((p) => this.toCleanId(p)))).sort()

		const fileTimings: Record<string, { loadMs: number; injectMs: number; plugin: 0 | 1 }> = {}

		for (const id of unique) {
			const t0 = process.hrtime.bigint()
			const mod = await this.runner.executeFile(id) // ① 拉取并执行
			const t1 = process.hrtime.bigint()

			// ② 交给 loader；返回值用于日志（是否注册了插件）
			const hasPlugin = !!this.ctx.loader.loadFileModule(id, mod)
			const t2 = process.hrtime.bigint()

			fileTimings[id] = {
				loadMs: Number((t1 - t0) / BigInt(1e6)),
				injectMs: Number((t2 - t1) / BigInt(1e6)),
				plugin: hasPlugin ? 1 : 0,
			}

			this.ctx.logger.info(
				`[HMR] 执行: ${id}\n` +
					`  • runner.executeFile: ${fileTimings[id].loadMs.toFixed(2)}ms\n` +
					`  • loadFileModule:     ${fileTimings[id].injectMs.toFixed(2)}ms` +
					(hasPlugin ? '\n  • 插件入口: yes' : ''),
			)
		}

		// ③ 批量提交：让依赖关系/容器实例在一次提交中达成一致
		const tc0 = process.hrtime.bigint()
		const res = await this.ctx.registry.commit()
		const tc1 = process.hrtime.bigint()
		this.ctx.logger.info(
			`[HMR] registry.commit(): ${Number((tc1 - tc0) / BigInt(1e6)).toFixed(2)}ms`,
		)

		// ④ 观测：给出最慢 Top5，便于持续优化
		const top = Object.entries(fileTimings)
			.sort(([, a], [, b]) => b.loadMs - a.loadMs)
			.slice(0, 5)
		if (top.length) {
			this.ctx.logger.info('【Top 5 慢加载文件】')
			for (const [p, t] of top)
				this.ctx.logger.info(`  ${t.loadMs.toFixed(1)}ms → ${p}${t.plugin ? ' (plugin)' : ''}`)
		}

		return res
	}

	// -------------------- DevServer 启动 --------------------
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
			// 服务端执行链建议禁用依赖预优化，以免 graph 形变
			optimizeDeps: {},
			ssr: { external: ['react', 'react-dom'] },
		})
		await server.listen()
		server.printUrls()
		this.ctx.logger.info(`HMR 服务已启动，只监听：${this.config.dir.join(', ')}`)
	}

	// -------------------- Graph/受影响子图 --------------------
	/** 从 FS 路径拿到 graph 模块节点列表（兼容 byFile / byId 两支） */
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
	 * - roots：受影响集合中“其 importer 不在集合内”的最上游节点（用于兜底执行）
	 */
	private collectAffected(fileOrId: string) {
		const startMods = this.getModulesByFile(fileOrId)
		const visited = new Set<string>()
		const affectedIds = new Set<string>()
		const idToMod = new Map<string, ModuleNode>()

		const stack = [...startMods]
		while (stack.length) {
			const m = stack.pop()!
			if (!m?.id) continue
			const id = this.cleanUrl(m.id)
			if (!this.filter(id) || id.startsWith('\0')) continue
			if (visited.has(id)) continue
			visited.add(id)
			affectedIds.add(id)
			idToMod.set(id, m)
			// 向上追溯所有 importers（= 依赖“我”的上游）
			for (const importer of m.importers) if (importer?.id) stack.push(importer)
		}

		// 选根：在集合里没有 importer 仍在集合内的节点
		const roots: string[] = []
		for (const id of affectedIds) {
			const m = idToMod.get(id)!
			const hasImporterInside = [...m.importers].some(
				(im) => im.id && affectedIds.has(this.cleanUrl(im.id)),
			)
			if (!hasImporterInside) roots.push(id)
		}

		return { affectedIds, roots }
	}

	// -------------------- 目标挑选（最近插件锚点） --------------------
	/**
	 * 读实时 anchors（this.ctx.loader.pathAnchors），对每个受影响点向上 BFS，
	 * 命中第一个锚点即返回（“最近”）；若任一节点无锚点可达，则回退执行 roots。
	 * - 单轮事件内使用 memo 去重同源查询
	 * - anchors 可能是任意路径形态，这里统一 cleanId 再判定
	 */
	private pickTargetsByAnchors(
		affectedIds: Set<string>,
		rawRoots: string[],
		pathAnchors: Set<string>,
	) {
		// 将 anchors 统一 cleanId（只在本次事件内做一次，避免反复清洗）
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

		// 若存在无锚点支路，追加传统 roots 兜底（roots 本身已是 cleanId）
		if (needFallbackRoots) for (const r of rawRoots) targets.add(this.toCleanId(r))
		return Array.from(targets)
	}

	/** 在受影响子图内，从起点向上 BFS；命中第一个锚点（最短链路）即返回 */
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

			// 命中最近锚点：立即返回
			if (anchors.has(id)) {
				memo.set(startCleanId, id)
				return id
			}

			for (const im of m.importers) if (im?.id) queue.push(im)
		}

		memo.set(startCleanId, null)
		return null
	}

	// -------------------- 缓存失效 --------------------
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
}
