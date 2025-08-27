import { type Context, Injectable } from '@pluxel/core'
import { resolve } from 'pathe'
import swc from 'unplugin-swc'
import {
	type Plugin,
	type ViteDevServer,
	createFilter,
	createServer,
	normalizePath, // ← 统一为 POSIX 分隔符
	version as viteVersion,
} from 'vite'
import tsconfigPaths from 'vite-tsconfig-paths'
import { ViteNodeServer } from 'vite-node/server'
import { ViteNodeRunner } from 'vite-node/client'
import { installSourcemapsSupport } from 'vite-node/source-map'

interface HMRConfig {
	dir: string[]
}

const serviceName = 'hmrService' as const
declare module '@pluxel/core' {
	interface Context {
		[serviceName]: HMRService
	}
}
@Injectable({ key: serviceName })
export class HMRService {
	private vite!: ViteDevServer
	private vns!: ViteNodeServer
	private runner!: ViteNodeRunner
	private filter!: (id: string) => boolean

	private swc = swc.vite({
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

			configureServer: async (server) => {
				this.vite = server

				// 1) vite-node 服务端
				this.vns = new ViteNodeServer(server, {
					transformMode: { ssr: [/\.([cm]?tsx?|jsx?)$/] },
					deps: {
						// 本地工作区/私有包走 inline（需要经过插件链）
						inline: [/^(@pluxel|valibot|valibot-form)\//],
						// 纯三方常量库走 external（减少 transform）
						external: [/^(react|react-dom|lodash|dayjs)(\/|$)/],
					},
				})

				// 2) 栈映射：把 getSourceMap 交给 vite-node
				installSourcemapsSupport({
					getSourceMap: (src) => this.vns.getSourceMap(src),
				})

				// 3) Runner：让 Node 以 Vite 方式加载/执行模块
				this.runner = new ViteNodeRunner({
					root: server.config.root,
					base: server.config.base,
					fetchModule: (id) => this.vns.fetchModule(id),
					resolveId: (id, importer) => this.vns.resolveId(id, importer),
				})

				console.time('[HMR] 扫描文件')
				const files = await this.ctx.loader.scanPossiblePaths(this.config.dir)
				console.timeEnd('[HMR] 扫描文件')

				console.time('[HMR] 预热/执行模块')
				await this.runAndLoadAll(files)
				console.timeEnd('[HMR] 预热/执行模块')
			},

			handleHotUpdate: async (ctx) => {
				if (!this.filter(ctx.file)) return
				this.ctx.logger.info(`[HMR] Reload due to ${ctx.file}`)

				// 1) 计算受影响图（向上递归）
				const { affectedIds, roots } = this.collectAffected(ctx.file)

				// 2) 统一失效缓存
				this.invalidateCaches(affectedIds)

				// 3) 只重跑“根”（最上游）——它们会级联拉起依赖的最新执行
				const targets = roots.length ? roots : [this.toViteId(ctx.file)]
				await this.runAndLoadAll(targets)

				return [] // 我们自己接管服务端 HMR
			},
		}
	}

	private toViteId(p: string) {
		return normalizePath(p) // Windows \ → /
	}

	private async runAndLoadAll(filesPath: string[]) {
		const fileTimings: Record<string, { loadMs: number; injectMs: number }> = {}

		for (const p of filesPath) {
			const id = this.toViteId(p)
			const t0 = process.hrtime.bigint()

			// ← 关键：由 Runner 执行，拿到模块 namespace
			const mod = await this.runner.executeFile(id)

			const t1 = process.hrtime.bigint()
			this.ctx.loader.loadFileModule(p, mod)
			const t2 = process.hrtime.bigint()

			fileTimings[p] = {
				loadMs: Number((t1 - t0) / BigInt(1e6)),
				injectMs: Number((t2 - t1) / BigInt(1e6)),
			}

			this.ctx.logger.info(
				`[HMR] 文件: ${p}\n` +
					`  • runner.executeFile: ${fileTimings[p].loadMs.toFixed(2)}ms\n` +
					`  • loadFileModule:     ${fileTimings[p].injectMs.toFixed(2)}ms`,
			)
		}

		const tc0 = process.hrtime.bigint()
		const res = await this.ctx.registry.commit()
		const tc1 = process.hrtime.bigint()
		this.ctx.logger.info(
			`[HMR] registry.commit(): ${Number((tc1 - tc0) / BigInt(1e6)).toFixed(2)}ms`,
		)

		const top = Object.entries(fileTimings)
			.sort(([, a], [, b]) => b.loadMs - a.loadMs)
			.slice(0, 5)
		this.ctx.logger.info('【Top 5 慢加载文件】')
		for (const [p, t] of top)
			this.ctx.logger.info(`  ${t.loadMs.toFixed(1)}ms → ${p}`)

		return res
	}

	public async start(): Promise<void> {
		const server = await createServer({
			root: process.cwd(),
			server: { port: 3000, middlewareMode: false },
			resolve: {
				// 3.34.1 解决了这个问题：https://github.com/tabler/tabler-icons/issues/1233#issuecomment-3094880359
				alias: {
					'@tabler/icons-react': '@tabler/icons-react/dist/esm/icons/index.mjs',
				},
			},
			plugins: [
				tsconfigPaths(),
				this.swc,
				this.plugin, // ← 我们的 vite-node 桥
				this.ctx.honoService.viteHonoDevServer,
			],
			// **服务端执行链**建议禁用依赖预优化
			optimizeDeps: {},
			ssr: { external: ['react', 'react-dom'] },
		})
		await server.listen()
		server.printUrls()
		this.ctx.logger.info(
			`HMR 服务已启动，只监听：${this.config.dir.join(', ')}`,
		)
	}

	// —— 小工具：去掉 ?v= / ?import 等查询 ——
	private cleanUrl(id: string) {
		const i = id.indexOf('?')
		return i >= 0 ? id.slice(0, i) : id
	}

	// —— 从 FS 路径拿到 Graph 模块 ——
	private getModulesByFile(file: string) {
		const id = this.toViteId(file)
		const byFile = this.vite.moduleGraph.getModulesByFile(id)
		if (byFile?.size) return [...byFile]
		const single = this.vite.moduleGraph.getModuleById(id)
		return single ? [single] : []
	}

	/** 向上递归收集：从 file 出发，收集它的所有（传递）importers
	 * 只保留命中 this.filter 的“业务代码”，跳过 node_modules/虚拟模块
	 * 返回：
	 *  - affectedIds: 需要失效的所有模块（clean 后的 id）
	 *  - roots: 在受影响子图中“没有 importer 在集合内”的最上游节点（clean id）
	 */
	private collectAffected(file: string) {
		const startMods = this.getModulesByFile(file)
		const visited = new Set<string>()
		const affectedIds = new Set<string>()
		const idToMod = new Map<string, import('vite').ModuleNode>()

		const stack = [...startMods]
		while (stack.length) {
			const m = stack.pop()!
			if (!m?.id) continue
			const id = this.cleanUrl(m.id)
			// 业务边界：只追溯我们关心的目录；虚拟模块(\0)跳过
			if (!this.filter(id) || id.startsWith('\0')) continue
			if (visited.has(id)) continue
			visited.add(id)
			affectedIds.add(id)
			idToMod.set(id, m)

			// 递归到所有 importers（= 依赖“我”的上游）
			for (const importer of m.importers) {
				if (!importer?.id) continue
				stack.push(importer)
			}
		}

		// 选出“根”：在受影响集合里，没有 importer 仍在集合内的模块
		const roots: string[] = []
		for (const id of affectedIds) {
			const m = idToMod.get(id)!
			const hasImporterInside = [...m.importers].some(
				(im) => im.id && affectedIds.has(this.cleanUrl(im.id!)),
			)
			if (!hasImporterInside) roots.push(id)
		}

		return { affectedIds, roots }
	}

	/** 统一失效：Vite graph + vite-node runner 缓存 */
	private invalidateCaches(affectedIds: Set<string>) {
		const g = this.vite.moduleGraph

		// 1) 失效 Vite 的 transform / ssr 缓存
		for (const id of affectedIds) {
			const mods = g.getModulesByFile(id)
			if (mods?.size) {
				for (const m of mods) g.invalidateModule(m)
			} else {
				const m = g.getModuleById(id)
				if (m) g.invalidateModule(m)
			}
		}

		// 2) 失效 vite-node 的执行缓存（含查询后缀的变体）
		//    这里既删 cleanId，也删 Map 里 clean 后相等的 key
		const keys = Array.from(this.runner.moduleCache.keys())
		for (const key of keys) {
			const base = this.cleanUrl(key)
			if (affectedIds.has(base)) this.runner.moduleCache.delete(key)
		}
	}
}
