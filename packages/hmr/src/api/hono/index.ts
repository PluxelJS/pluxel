import { newHttpBatchRpcResponse } from 'capnweb'
import { Hono } from 'hono'

import loggerApp from '../../services/logger/api'
import type { AppEnv } from './env'
import { HmrRpcApi, PluginHandle } from './rpc'

const app = new Hono<AppEnv>()
	.get('/', (c) => c.text('Pluxel HMR RPC ready'))
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
		const extensionService = ctx.extensionService
		if (!extensionService) {
			return c.json({ version: 0, bundles: [] })
		}
		return c.json(extensionService.getManifest())
	})
	// 获取插件 bundle
	.get('/extensions/:pluginName/bundle.mjs', async (c) => {
		const ctx = c.var.plugin_ctx
		const extensionService = ctx.extensionService
		if (!extensionService) {
			return c.text('Extension service not available', 503)
		}
		const pluginName = c.req.param('pluginName')
		const bundle = await extensionService.getBundle(pluginName)
		if (!bundle) {
			return c.text('Bundle not found', 404)
		}
		return c.text(bundle, 200, {
			'Content-Type': 'application/javascript',
			'Cache-Control': 'no-cache',
		})
	})
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
	.get('/debug/plugins/:name/schema', (c) => {
		const name = c.req.param('name')
		const handle = new PluginHandle(c.var.plugin_ctx, name)
		const result = handle.schema()
		return c.json(result, result.ok ? 200 : 404)
	})
	.get('/debug/schemas', (c) => {
		const ctx = c.var.plugin_ctx
		const registry = ctx.loader.registry
		const names = registry.getLoadedNames()
		const result: Record<string, { hasSchema: boolean; hasSchemaSource: boolean; schemaSource?: Record<string, string> }> = {}
		for (const name of names) {
			const ctor = registry.getPluginByName(name)
			if (!ctor) continue
			const schema = registry.getSchema(ctor)
			const schemaSource = registry.getSchemaSource(ctor)
			result[name] = {
				hasSchema: !!schema && Object.keys(schema).length > 0,
				hasSchemaSource: !!schemaSource && Object.keys(schemaSource).length > 0,
				schemaSource: schemaSource ?? undefined,
			}
		}
		return c.json(result)
	})
	.route('/logs', loggerApp)
	.all('/graphql', (c) => c.var.plugin_ctx.internalGraphql.fetch(c.req.raw, { hono: c } as any))

export default app

export type AppType = typeof app
export { HmrRpcApi, PluginHandle } from './rpc'
