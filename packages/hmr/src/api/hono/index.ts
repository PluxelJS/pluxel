import { newHttpBatchRpcResponse } from 'capnweb'
import { Hono } from 'hono'

import loggerApp from '../../services/logger/api'
import debugApp from './debug'
import type { AppEnv } from './env'
import { HmrRpcApi, PluginHandle } from './rpc'

const app = new Hono<AppEnv>()
	.get('/', (c) => c.text('Pluxel HMR RPC ready'))
	// ============ 认证元信息（不受守卫保护） ============
	.get('/auth/meta', async (c) => {
		const ctx = c.var.plugin_ctx
		const authGuard = ctx.authGuard

		// 未启用守卫：前端不需要做任何登录相关处理
		if (!authGuard || !authGuard.isActive()) {
			return c.json(
				{
					enabled: false,
					pluginName: null,
					redirectPath: null,
					authenticated: true,
				},
				200,
				{ 'Cache-Control': 'no-store' },
			)
		}

		const request = c.req.raw
		const headers = request.headers instanceof Headers ? request.headers : new Headers(request.headers)

		const result = await authGuard.check({
			kind: 'api',
			path: c.req.path,
			method: c.req.method,
			url: c.req.url,
			headers,
			request,
		})

		return c.json(
			{
				enabled: true,
				pluginName: authGuard.getActivePluginName() ?? null,
				redirectPath: authGuard.getRedirectPath() ?? null,
				authenticated: result.allow,
			},
			200,
			{ 'Cache-Control': 'no-store' },
		)
	})
	// Server-Sent Events：统一入口，支持多命名空间复用单条连接
	.get('/sse', (c) => c.var.plugin_ctx.ext.sse.stream(c))
	.get('/sse/namespaces', (c) => c.json({ namespaces: c.var.plugin_ctx.ext.sse.getNamespaces() }))
	.all('/rpc', async (c) => {
		try {
			const api = new HmrRpcApi(c.var.plugin_ctx)
			return await newHttpBatchRpcResponse(c.req.raw, api)
		} catch (err) {
			console.error('[RPC] Error handling request:', err)
			return c.text('Internal RPC error', 500)
		}
	})
	// ============ Extension API ============
	// 获取扩展清单
	.get('/extensions/manifest', (c) => {
		const ctx = c.var.plugin_ctx
		const extensionService = ctx.ext.ui
		if (!extensionService) {
			return c.json({ version: 0, modules: [] })
		}
		return c.json(extensionService.getManifest())
	})
	// 获取单个插件模块
	.get('/extensions/modules/:plugin/:file', async (c) => {
		const ctx = c.var.plugin_ctx
		const extensionService = ctx.ext.ui
		if (!extensionService) {
			return c.text('Extension service not available', 503)
		}
		const pluginParam = c.req.param('plugin')
		const pluginName = decodeURIComponent(pluginParam)
		const file = c.req.param('file')
		const hash = file.endsWith('.mjs') ? file.slice(0, -4) : file
		const code = await extensionService.getModuleSource(pluginName, hash)
		if (!code) {
			return c.text('Module not found', 404)
		}
		return c.text(code, 200, {
			'Content-Type': 'application/javascript',
			'Cache-Control': 'public, max-age=31536000, immutable',
		})
	})
	.get('/extensions/events', (c) => c.var.plugin_ctx.ext.sse.stream(c, ['extensions']))
	// ============ REST API（仅调试/直连调试用） ============
	// 仅保留 schema GET，方便通过浏览器快速排查，无需 RPC 客户端
	.get('/plugins/:name/schema', (c) => {
		const name = c.req.param('name')
		const handle = new PluginHandle(c.var.plugin_ctx, name)
		return c.json(handle.schema())
	})
	// 插件分组（仍使用 REST，因 UI 直接发请求）
	.get('/plugin-groups', (c) => {
		const api = new HmrRpcApi(c.var.plugin_ctx)
		return c.json(api.pluginGroups())
	})
	.post('/plugin-groups', async (c) => {
		const api = new HmrRpcApi(c.var.plugin_ctx)
		const groups = await c.req.json()
		return c.json(api.updatePluginGroups(groups))
	})
	// ============ 调试路由 ============
	.route('/debug', debugApp)
	.route('/logs', loggerApp)
	.all('/graphql', (c) => c.var.plugin_ctx.internalGraphql.fetch(c.req.raw, { hono: c } as any))

export default app

export type AppType = typeof app
export { HmrRpcApi, PluginHandle } from './rpc'
