import { type Context, Injectable } from '@pluxel/core'
import { resolve } from 'pathe'
import swc from 'unplugin-swc'
import {
	type Plugin,
	type ViteDevServer,
	createFilter,
	createServer,
} from 'vite'
import tsconfigPaths from 'vite-tsconfig-paths'

interface HMRConfig {
	dir: string[]
}
declare module '@pluxel/core' {
	interface Context {
		hmrService: HMRService
	}
	namespace Context {
		interface Config {
			hmrService: HMRConfig
		}
	}
}
@Injectable
export class HMRService {
	static key = 'hmrService'
	private viteServer!: ViteDevServer
	private filter: (id: string) => boolean
	private plugin: Plugin

	constructor(
		private ctx: Context,
		private config: HMRConfig,
	) {
		// 1. 生成过滤器
		const includeGlobs = config.dir.map((d) => resolve(d, '**/*.ts'))
		this.filter = createFilter(includeGlobs)

		// 3. 定义插件
		this.plugin = {
			name: 'pluxel-runner',
			apply: 'serve',

			// 用 service 而不是 this
			configureServer: async (server) => {
				this.viteServer = server
				console.time('[HMR] 扫描文件') // 开始计时
				const files = await this.ctx.loader.scanPossiblePaths(config.dir)
				console.timeEnd('[HMR] 扫描文件') // 打印耗时

				console.time('[HMR] 预热加载模块')
				await this.runAndLoadAll(files)
				console.timeEnd('[HMR] 预热加载模块')
			},

			handleHotUpdate: async (ctx) => {
				if (!this.filter(ctx.file)) return
				this.ctx.logger.info(`[HMR-CLI] Reload due to ${ctx.file}`)
				await this.runAndLoadAll([ctx.file])
				return []
			},
		}
	}

	private async runAndLoadAll(filesPath: string[]) {
		// 存储每个文件的各阶段耗时
		const fileTimings: Record<string, { loadMs: number; injectMs: number }> = {}

		// 1. 针对每个文件，分别测 ssrLoadModule 和 loadFileModule
		for (const p of filesPath) {
			const t0 = process.hrtime.bigint()
			// SWC 编译 + 模块加载
			const mod = await this.viteServer.ssrLoadModule(p)
			const t1 = process.hrtime.bigint()
			// 注入到你的 loader
			this.ctx.loader.loadFileModule(p, mod)
			const t2 = process.hrtime.bigint()

			const loadMs = Number((t1 - t0) / BigInt(1e6))
			const injectMs = Number((t2 - t1) / BigInt(1e6))
			fileTimings[p] = { loadMs, injectMs }

			this.ctx.logger.info(
				`[HMR] 文件: ${p}\n` +
					`  • ssrLoadModule: ${loadMs.toFixed(2)}ms\n` +
					`  • loadFileModule: ${injectMs.toFixed(2)}ms`,
			)
		}

		// 2. 测 registry.commit()
		const tc0 = process.hrtime.bigint()
		const res = await this.ctx.registry.commit()
		const tc1 = process.hrtime.bigint()
		const commitMs = Number((tc1 - tc0) / BigInt(1e6))
		this.ctx.logger.info(`[HMR] registry.commit(): ${commitMs.toFixed(2)}ms`)

		// 3. 汇总最慢的几个文件
		const sorted = Object.entries(fileTimings)
			.sort(([, a], [, b]) => b.loadMs - a.loadMs)
			.slice(0, 5)
		this.ctx.logger.info('【Top 5 慢加载文件】')
		for (const [p, t] of sorted) {
			this.ctx.logger.info(`  ${t.loadMs.toFixed(1)}ms → ${p}`)
		}

		return res
	}

	public async start(): Promise<void> {
		const server = await createServer({
			root: process.cwd(),
			server: { port: 3000, middlewareMode: false },
			resolve: {
				alias: {
					// /esm/icons/index.mjs only exports the icons statically, so no separate chunks are created
					'@tabler/icons-react': '@tabler/icons-react/dist/esm/icons/index.mjs',
				},
			},
			plugins: [
				tsconfigPaths(),
				swc.vite({
					sourceMaps: true,
					inlineSourcesContent: true,
					jsc: {
						externalHelpers: true, // 避免把 helper 内联到文件头导致行偏移，需要 @swc/helpers
						parser: { syntax: 'typescript', decorators: true, tsx: true },
						transform: {
							legacyDecorator: true,
							decoratorMetadata: true,
							react: { runtime: 'automatic', refresh: true },
						},
					},
				}),
				// 如果插件引用了大依赖(比如误引入HMR包/前端包)会导致长加载时间。
				this.plugin,
				this.ctx.honoService.viteHonoDevServer,
			],
			// 加上这段，确保 SSR 阶段不把 Mantine 当外部模块给揽进来处理
			optimizeDeps: {
				include: ['valibot', '@pluxel/core', 'diod'],
				// 这里千万不能加 mantine 和 tanstack 的东西, exclude 会导致部分渲染出问题。
			},
			ssr: {
				external: ['react', 'react-dom'],
			},
		})
		await server.listen()
		server.printUrls()
		this.ctx.logger.info(
			`HMR 服务已启动，只监听：${this.config.dir.join(', ')}`,
		)
	}
}
