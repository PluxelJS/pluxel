import devServer from '@hono/vite-dev-server'
import { type Context, Injectable } from '@pluxel/core'
import { createFactory, type Factory } from 'hono/factory'
import type { Plugin } from 'vite'
import api from '../../app/api'
import { ssrApp } from '../../server'
import loggerApi from '../logger/api'
import type { AppEnv, HonoType } from './env'

type AppMod = (app: HonoType) => void

const serviceName = 'honoService' as const
declare module '@pluxel/core' {
	interface Context {
		[serviceName]: HonoService
	}
}

const escapeRE = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

@Injectable({ key: serviceName })
export class HonoService {
	/** 已注册补丁（引用稳定，可撤销） */
	private mods = new Set<AppMod>()
	/** 当前应用实例 */
	private app: HonoType
	/** dev：是否需要在下一次 HMR 钩子里触发 full-reload */
	private shouldReload = false

	constructor(private ctx: Context) {
		this.app = this.rebuildApp()
	}

	/** 将 plugin_ctx 注入到 c.env */
	public createFactory(): Factory<AppEnv, string> {
		return createFactory<AppEnv>({
			initApp: (app) => {
				app.use(async (c, next) => {
					c.set('plugin_ctx', this.ctx)
					await next()
				})
			},
		})
	}

	/** 重建：API → 补丁 → logger → SSR（顺序很重要） */
	private rebuildApp(): HonoType {
		const app = this.createFactory().createApp()
		app.route('/api', api)

		for (const m of this.mods) m(app)

		app.route('/', loggerApi)
		app.route('/', ssrApp) // 放最后做兜底
		return app
	}

	/** 只读 fetch 入口 */
	get fetch() {
		return this.app.fetch
	}

	/** 动态注入/撤销补丁（HMR 友好） */
	modifyApp(mod: AppMod) {
		this.mods.add(mod)
		this.app = this.rebuildApp()
		this.markReloadNeed()

		return this.ctx.scope.collectEffect(() => {
			if (this.mods.delete(mod)) {
				this.app = this.rebuildApp()
				this.markReloadNeed()
			}
		})
	}

	/**
	 * 静态资源挂载（自动剥前缀 + 去前导斜杠，确保 join(root, rel)）
	 * 例：mountStatic('/ttttt', { root: '.', index: 'index.html' })
	 */
	mountStatic(
		prefix: `/${string}`,
		options: { root: string; index?: string; precompressed?: boolean },
	) {
		return this.modifyApp(async (app) => {
			const { serveStatic } = await import('@hono/node-server/serve-static')

			const normalized = prefix.length > 1 && prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
			const re = new RegExp(`^${escapeRE(normalized)}`)

			app.use(
				`${normalized}/*`,
				serveStatic({
					root: options.root, // 建议相对 cwd
					precompressed: options.precompressed ?? false,
					// 关键：剥前缀后再去掉前导 '/'，否则 join(root, '/x') 会丢 root
					rewriteRequestPath: (p) => p.replace(re, '').replace(/^\/+/, ''),
					onFound: (fsPath, c) =>
						this.ctx.logger.debug?.(`static hit  -> fs:${fsPath} req:${c.req.path}`),
					onNotFound: (fsPath, c) =>
						this.ctx.logger.debug?.(`static miss -> fs:${fsPath} req:${c.req.path}`),
				} as any),
			)

			if (options.index) {
				app.get(normalized, (c) => c.redirect(`${normalized}/${options.index}`))
			}
		})
	}

	/** 仅做标记：下一次 HMR 钩子里再 full-reload（不持有 vite 引用） */
	private markReloadNeed() {
		this.shouldReload = true
	}

	/** Vite dev server 插件：只在需要时 full-reload */
	get viteHonoDevServer(): Plugin {
		return devServer({
			loadModule: async () => ({ fetch: this.fetch }) as any,
			handleHotUpdate: ({ server }) => {
				this.ctx.logger.debug('触发 HMR')
				if (this.shouldReload) {
					this.ctx.logger.debug('触发全量重载')
					this.shouldReload = false
					server.ws.send({ type: 'full-reload' })
				}
				return []
			},
		}) as Plugin
	}
}
