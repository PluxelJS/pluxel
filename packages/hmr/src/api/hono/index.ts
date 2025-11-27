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
	// ============ REST API 路由（替代 capnweb RPC） ============
	// 插件 schema
	.get('/plugins/:name/schema', (c) => {
		const name = c.req.param('name')
		const handle = new PluginHandle(c.var.plugin_ctx, name)
		return c.json(handle.schema())
	})
	// 插件 config
	.get('/plugins/:name/config', (c) => {
		const name = c.req.param('name')
		const handle = new PluginHandle(c.var.plugin_ctx, name)
		return c.json(handle.config())
	})
	// 插件状态
	.get('/plugins/:name/status', (c) => {
		const name = c.req.param('name')
		const handle = new PluginHandle(c.var.plugin_ctx, name)
		return c.json(handle.status())
	})
	// 保存插件配置
	.post('/plugins/:name/config', async (c) => {
		const name = c.req.param('name')
		const handle = new PluginHandle(c.var.plugin_ctx, name)
		const patch = await c.req.json()
		return c.json(handle.saveConfig(patch))
	})
	// 重置插件配置
	.post('/plugins/:name/config/reset', async (c) => {
		const name = c.req.param('name')
		const handle = new PluginHandle(c.var.plugin_ctx, name)
		const body = await c.req.json().catch(() => ({}))
		return c.json(handle.resetConfig(body.keys))
	})
	// 更新插件状态（start/stop/restart/enable/disable）
	.post('/plugins/:name/status', async (c) => {
		const name = c.req.param('name')
		const handle = new PluginHandle(c.var.plugin_ctx, name)
		const { action } = await c.req.json()
		return c.json(await handle.updateStatus(action))
	})
	// 全局插件状态概览
	.get('/plugin-status', (c) => {
		const api = new HmrRpcApi(c.var.plugin_ctx)
		return c.json(api.pluginStatus())
	})
	// 插件分组
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
