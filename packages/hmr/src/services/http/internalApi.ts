import { newHttpBatchRpcResponse } from 'capnweb'
import { HMR_INTERNAL_API_BASE } from '@pluxel/hmr-web'
import { Hono } from 'hono'

import debugApp from '../../api/hono/debug'
import logsApp from '../../api/hono/logs'
import mcpApp from '../../api/hono/mcp'
import { HmrRpcApi, PluginHandle } from '../../api/hono/rpc'
import type { AppEnv } from './hono-env'

function createInternalGraphqlRequest(req: Request): Request {
	const url = new URL(req.url)
	url.pathname = `${HMR_INTERNAL_API_BASE}/graphql`
	return new Request(url, req)
}

async function guardInternalApiValidation(
	c: import('hono').Context<AppEnv>,
): Promise<Response | undefined> {
	const ctx = c.var.plugin_ctx
	const service = ctx.internalApiValidation
	if (!service?.hasValidators()) return undefined

	const request = c.req.raw
	const headers =
		request.headers instanceof Headers ? request.headers : new Headers(request.headers)
	const url = c.req.url
	const path = c.req.path
	const method = (request.method ?? c.req.method).toUpperCase()

	const result = await service.check({
		path,
		method,
		url,
		headers,
		request,
	})
	if (result.allow === true) return undefined

	ctx.logger.warn('Blocked internal API request (validation)', {
		path,
		method,
		pluginName: result.pluginName,
	})

	return c.json(
		{
			allow: false,
			code: 'internal_api_blocked',
			path,
			method,
			pluginName: result.pluginName,
		},
		403,
		{
			'Cache-Control': 'no-store',
			'X-Pluxel-Internal-Blocked': '1',
		},
	)
}

async function guardInternalRequest(
	c: import('hono').Context<AppEnv>,
): Promise<Response | undefined> {
	const ctx = c.var.plugin_ctx
	const service = ctx.authGuard
	if (!service || !service.isActive()) return undefined

	const request = c.req.raw
	const headers =
		request.headers instanceof Headers ? request.headers : new Headers(request.headers)
	const url = c.req.url
	const path = c.req.path
	const method = (request.method ?? c.req.method).toUpperCase()

	if (path === '/auth/meta') return undefined

	const result = await service.check({
		kind: 'api',
		path,
		method,
		url,
		headers,
		request,
	})
	if (result.allow === true) return undefined

	ctx.logger.warn('Blocked request', {
		kind: 'api',
		path,
		method,
		pluginName: result.pluginName,
	})

	return c.json(
		{
			allow: false,
			code: 'access_denied',
			kind: 'api',
			path,
			method,
			pluginName: result.pluginName,
			redirectPath: result.redirectPath,
		},
		401,
		{
			'Cache-Control': 'no-store',
			'X-Pluxel-Auth-Blocked': '1',
			'X-Pluxel-Redirect-Path': result.redirectPath,
		},
	)
}

export function createInternalApiBoundary(app: Hono<AppEnv> = new Hono<AppEnv>()) {
	return app
		.use('*', async (c, next) => {
			const deniedByValidation = await guardInternalApiValidation(c)
			if (deniedByValidation) return deniedByValidation
			const denied = await guardInternalRequest(c)
			if (denied) return denied
			return next()
		})
		.get('/', (c) => c.text('Pluxel HMR RPC ready'))
		.get('/auth/meta', async (c) => {
			const ctx = c.var.plugin_ctx
			const authGuard = ctx.authGuard

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
			const headers =
				request.headers instanceof Headers ? request.headers : new Headers(request.headers)

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
		.get('/sse', (c) => c.var.plugin_ctx.ext.sse.stream(c))
		.get('/sse/namespaces', (c) =>
			c.json({ namespaces: c.var.plugin_ctx.ext.sse.getNamespaces() }),
		)
		.all('/rpc', async (c) => {
			try {
				const api = new HmrRpcApi(c.var.plugin_ctx)
				return await newHttpBatchRpcResponse(c.req.raw, api)
			} catch (err) {
				c.var.plugin_ctx.logger.error('RPC request failed', { error: err })
				return c.text('Internal RPC error', 500)
			}
		})
		.get('/extensions/manifest', (c) => {
			const ctx = c.var.plugin_ctx
			const extensionService = ctx.ext.ui
			if (!extensionService) {
				return c.json({ version: 0, modules: [] })
			}
			return c.json(extensionService.getManifest())
		})
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
		.get('/plugins/:name/schema', (c) => {
			const name = c.req.param('name')
			const handle = new PluginHandle(c.var.plugin_ctx, name)
			return c.json(handle.schema())
		})
		.route('/debug', debugApp)
		.route('/logs', logsApp)
		.route('/mcp', mcpApp)
		.all('/graphql', (c) => {
			return c.var.plugin_ctx.internalGraphql.fetch(createInternalGraphqlRequest(c.req.raw), {
				hono: c,
			} as any)
		})
}
