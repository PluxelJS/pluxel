import path from 'node:path'
import { type Context, Injectable } from '@pluxel/core'
import swc from 'unplugin-swc'
import {
	type Plugin,
	type ViteDevServer,
	createFilter,
	createServer,
} from 'vite'
import tsconfigPaths from 'vite-tsconfig-paths'
function normalize(p: string) {
	return path.resolve(p).split(path.sep).join(path.posix.sep)
}
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
		const includeGlobs = config.dir.map((d) => path.posix.join(d, '**/*.ts'))
		this.filter = createFilter(includeGlobs)

		// 3. 定义插件
		this.plugin = {
			name: 'pluxel-runner',
			apply: 'serve',

			// 用 service 而不是 this
			configureServer: async (server) => {
				this.viteServer = server
				await this.runAndLoadAll(
					(await this.ctx.loader.getAllTsFiles(config.dir)).map(normalize),
				)
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
		for (const p of filesPath) {
			const mod = await this.viteServer.ssrLoadModule(p)
			this.ctx.loader.loadFileModule(p, mod)
		}
		const res = await this.ctx.registry.commit()
		if (res.ok) {
			console.log(
				'%c🤪 ~ file: HMRService.ts:69 [] -> res.val.container.services : ',
				'color: #267272',
				res.val.container.services.keys(),
			)
		}
	}

	public async start() {
		const server = await createServer({
			root: process.cwd(),
			server: { port: 3000, middlewareMode: false },
			plugins: [
				tsconfigPaths(),
				swc.vite({
					jsc: {
						parser: {
							syntax: 'typescript',
							decorators: true,
						},
						transform: {
							legacyDecorator: true,
							decoratorMetadata: true,
						},
					},
				}),
				this.plugin,
				this.ctx.honoService.vitePlugin,
			],
		})
		await server.listen()
		server.printUrls()
		this.ctx.logger.info(
			`HMR 服务已启动，只监听：${this.config.dir.join(', ')}`,
		)
	}
}
