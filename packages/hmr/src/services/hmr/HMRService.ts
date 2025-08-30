import { type Context, Injectable } from '@pluxel/core'
import { resolvePath as mllyResolvePath, pathToFileURL } from 'mlly'
import { resolve } from 'pathe'
import swc from 'unplugin-swc'
import {
	createFilter,
	createServer,
	normalizePath, // ← 统一为 POSIX 分隔符
	type Plugin,
	type ViteDevServer,
} from 'vite'
import type { ViteNodeResolveId } from 'vite-node'
import { ViteNodeRunner } from 'vite-node/client'
import { ViteNodeServer } from 'vite-node/server'
import { installSourcemapsSupport } from 'vite-node/source-map'
import tsconfigPaths from 'vite-tsconfig-paths'

interface HMRConfig {
	dir: string[]
}

// —— 是否裸导入 —— //
const isBare = (id: string) =>
	!!id &&
	!id.startsWith('.') &&
	!id.startsWith('/') &&
	!id.startsWith('file:') &&
	!id.startsWith('\0')

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

	private isInWatchedDir(p: string) {
		const np = normalizePath(p)
		// 只要 importer 落在 config.dir 任一前缀下，就认为在子包内
		return this.config.dir
			.map((d) => normalizePath(resolve(d)))
			.some((root) => np === root || np.startsWith(root + '/'))
	}

	constructor(
		private ctx: Context,
		private config: HMRConfig,
	) {
		this.filter = createFilter(
			this.config.dir.map((d) => normalizePath(resolve(d, '**/*.{ts,tsx,cts,mts,js,mjs}'))),
			['**/node_modules/**', '**/.vite/**', '**/.git/**', '\0*'],
		)

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

				// 2) SourceMap 交给 vite-node
				installSourcemapsSupport({
					getSourceMap: (src) => this.vns.getSourceMap(src),
				})

				// 3) Runner：保持精简，resolveId 再兜底一次（极端情况下）
				this.runner = new ViteNodeRunner({
					root: server.config.root,
					base: server.config.base,
					interopDefault: true, // esm cjs 互操作

					// fetchModule 只有 id
					fetchModule: (id) => {
						this.ctx.logger.debug(id)
						return this.vns.fetchModule(id)
					},

					// 关键：先走 vite-node 的解析；只有“裸 id 外部化”且 importer 在子包，才接管
					resolveId: async (id, importer) => {
						const r = await this.vns.resolveId(id, importer)
						// vite-node 已经解析成绝对路径/URL 或虚拟模块，直接用
						if (!importer) return r as ViteNodeResolveId

						const imp = this.cleanUrl(importer)
						const inSubpkg = this.isInWatchedDir(imp)
						if (!inSubpkg || !isBare(id)) return r as ViteNodeResolveId

						// 抽取“vite-node 的解析结果”
						const rId = typeof r === 'string' ? r : r?.id
						const rExternal = typeof r === 'string' ? false : !!r?.external

						// 条件：vite-node 把它当 external，但仍是“裸 id”（说明没解析到具体文件）
						const looksLikeBareExternal =
							(rExternal && !!rId && isBare(rId)) || (typeof r === 'string' && r === id)

						if (!looksLikeBareExternal) {
							// 已经被解析成绝对路径/真实文件了，尊重 vite-node
							return r as ViteNodeResolveId
						}

						// ← 仅此时接管：按 importer 作为起点，就近解析到子包自己的 node_modules
						try {
							const abs = await mllyResolvePath(id, {
								url: pathToFileURL(imp),
								conditions: ['@pluxel/source', 'development', 'node', 'import', 'default'],
								extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'],
							})
							// 告诉 vite：这是外部模块，直接让 Node import 绝对文件，不再走 URL/transform
							return { id: abs, external: true } as ViteNodeResolveId
						} catch {
							// 解析失败则尊重 vite-node 的结果，保持不破坏
							return r as ViteNodeResolveId
						}
					},
				})

				console.time('[HMR] 扫描文件')
				const files = await this.ctx.scanService.scan(this.config.dir)
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

				// 3) 只重跑“根”（最上游）
				const targets = roots.length ? roots : [this.toViteId(ctx.file)]
				await this.runAndLoadAll(targets)

				return [] // 自己接管服务端 HMR
			},
		}
	}

	private toViteId(p: string) {
		return normalizePath(p)
	}

	// —— 清理 ?v= / ?import —— //
	private cleanUrl(id: string) {
		const i = id.indexOf('?')
		return i >= 0 ? id.slice(0, i) : id
	}

	// —— 运行 & 注入 —— //
	private async runAndLoadAll(filesPath: string[]) {
		const fileTimings: Record<string, { loadMs: number; injectMs: number }> = {}

		for (const p of filesPath) {
			const id = this.toViteId(p)
			const t0 = process.hrtime.bigint()

			// 由 Runner 执行，拿到模块 namespace
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
		for (const [p, t] of top) this.ctx.logger.info(`  ${t.loadMs.toFixed(1)}ms → ${p}`)

		return res
	}

	public async start(): Promise<void> {
		const allow = Array.from(
			new Set([process.cwd(), ...this.config.dir.map((d) => normalizePath(resolve(d)))]),
		)

		const server = await createServer({
			root: process.cwd(),
			server: { port: 3000, middlewareMode: false, fs: { allow } },
			resolve: {
				// 让解析落到真实路径（pnpm + 子包 node_modules 必需）
				preserveSymlinks: false,
				alias: {
					'@tabler/icons-react': '@tabler/icons-react/dist/esm/icons/index.mjs',
				},
			},
			plugins: [
				tsconfigPaths(),
				this.swc,
				this.plugin, // ← 我们的 vite-node 桥（含 resolveId 兜底）
				this.ctx.honoService.viteHonoDevServer,
			],
			optimizeDeps: { disabled: true },
			ssr: {
				noExternal: [/^@pluxel\/.+/], // 工作区源码参与 HMR
				external: ['react', 'react-dom'], // Node-only 交给 Node
			},
		})
		await server.listen()
		server.printUrls()
		this.ctx.logger.info(`HMR 服务已启动，只监听：${this.config.dir.join(', ')}`)
	}

	// —— Vite 图工具 —— //
	private getModulesByFile(file: string) {
		const id = this.toViteId(file)
		const byFile = this.vite.moduleGraph.getModulesByFile(id)
		if (byFile?.size) return [...byFile]
		const single = this.vite.moduleGraph.getModuleById(id)
		return single ? [single] : []
	}

	private collectAffected(file: string) {
		const startMods = this.getModulesByFile(file)
		const seen = new Set<string>()
		const affected = new Set<string>()
		const idToMod = new Map<string, import('vite').ModuleNode>()

		const isBiz = (id: string) =>
			this.filter(id) && !id.includes('/node_modules/') && !id.startsWith('\0')

		const stack = [...startMods]
		while (stack.length) {
			const m = stack.pop()!
			if (!m?.id) continue
			const id = this.cleanUrl(m.id)
			if (!isBiz(id) || seen.has(id)) continue
			seen.add(id)
			affected.add(id)
			idToMod.set(id, m)
			for (const im of m.importers) if (im?.id) stack.push(im)
		}

		const roots: string[] = []
		for (const id of affected) {
			const m = idToMod.get(id)!
			const hasInner = [...m.importers].some((im) => {
				const cid = im.id && this.cleanUrl(im.id)
				return !!cid && affected.has(cid)
			})
			if (!hasInner) roots.push(id)
		}
		return { affectedIds: affected, roots }
	}

	private invalidateCaches(affectedIds: Set<string>) {
		const g = this.vite.moduleGraph

		for (const id of affectedIds) {
			const mods = g.getModulesByFile(id)
			if (mods?.size) for (const m of mods) g.invalidateModule(m)
			const m = g.getModuleById(id)
			if (m) g.invalidateModule(m)
		}

		for (const key of Array.from(this.runner.moduleCache.keys())) {
			const base = this.cleanUrl(key)
			if (affectedIds.has(base)) this.runner.moduleCache.delete(key)
		}

		for (const id of affectedIds) {
			const mods = g.getModulesByFile(id) ?? new Set()
			for (const m of mods) {
				for (const importer of m.importers) {
					if (!importer?.id) continue
					const iid = this.cleanUrl(importer.id)
					if (this.filter(iid)) g.invalidateModule(importer)
				}
			}
		}
	}
}
