import type { Context as PluginContext } from '@pluxel/core'
import { HMR_INTERNAL_API_BASE, HMR_META_AUTH_PATH, HMR_TRANSPORT_PATHS } from '@pluxel/hmr-web'
import { newHttpBatchRpcResponse } from 'capnweb'

import { extensionRoutes } from '../../api/http/extensions'
import { metaRoutes } from '../../api/http/meta'
import { debugRoutes } from '../../api/http/debug'
import { logRoutes } from '../../api/http/logs'
import { pluginNameParams } from '../../api/http/models'
import { HmrRpcApi, PluginHandle } from '../../api/http/rpc'
import { getHmrMcpHttpHandler } from '../../api/mcp'
import type { ElysiaBoundaryBuilder } from './HttpService'
import { createElysiaApp } from './elysia'

type BaseElysiaApp = any

function resolveRequestKind(path: string): 'api' | 'graphql' {
	return path === `${HMR_INTERNAL_API_BASE}${HMR_TRANSPORT_PATHS.graphql}` ? 'graphql' : 'api'
}

function createInternalPlugin(
	ctx: PluginContext,
	name: string,
	build: (app: BaseElysiaApp) => unknown,
): BaseElysiaApp {
	const app = createElysiaApp(ctx, {
			aot: true,
			name: `pluxel.http.internal.${name}`,
		}) as unknown as BaseElysiaApp
	return build(app) as unknown as BaseElysiaApp
}

function applyInternalApiGuard(app: BaseElysiaApp): BaseElysiaApp {
	return app.onBeforeHandle(async ({ pluginCtx, request, set, status }: any) => {
			const path = new URL(request.url).pathname
			const method = (request.method ?? 'GET').toUpperCase()

			const validation = pluginCtx.internalApiValidation
			if (validation?.hasValidators()) {
				const result = await validation.check({
					path,
					method,
					url: request.url,
					headers: request.headers,
					request,
				})
				if (result.allow !== true) {
					set.headers['cache-control'] = 'no-store'
					set.headers['x-pluxel-internal-blocked'] = '1'
					pluginCtx.logger.warn('Blocked internal API request (validation)', {
						path,
						method,
						pluginName: result.pluginName,
					})

					return status(403, {
						allow: false,
						code: 'internal_api_blocked',
						path,
						method,
						pluginName: result.pluginName,
					})
				}
			}

			const authGuard = pluginCtx.authGuard
			if (!authGuard || !authGuard.isActive() || path === HMR_META_AUTH_PATH) {
				return undefined
			}

			const kind = resolveRequestKind(path)
			const result = await authGuard.check({
				kind,
				path,
				method,
				url: request.url,
				headers: request.headers,
				request,
			})
			if (result.allow === true) return undefined

			pluginCtx.logger.warn('Blocked request', {
				kind,
				path,
				method,
				pluginName: result.pluginName,
			})

			set.headers['cache-control'] = 'no-store'
			set.headers['x-pluxel-auth-blocked'] = '1'
			set.headers['x-pluxel-redirect-path'] = result.redirectPath
			return status(401, {
				allow: false,
				code: 'access_denied',
				kind,
				path,
				method,
				pluginName: result.pluginName,
				redirectPath: result.redirectPath,
			})
		}) as BaseElysiaApp
}

function createInternalTransportPlugins(ctx: PluginContext): BaseElysiaApp[] {
	const mcpHandler = getHmrMcpHttpHandler(ctx)

	return [
		createInternalPlugin(ctx, 'root', (app) => app.get('/', 'Pluxel HMR RPC ready')),
		createInternalPlugin(ctx, 'plugin-schema', (app) =>
			app.get(
					'/plugins/:name/schema',
					async ({ pluginCtx, params }: any) => {
						const handle = new PluginHandle(pluginCtx, params.name)
						return await handle.schema()
					},
					{
						params: pluginNameParams,
					},
				),
		),
		createInternalPlugin(ctx, 'sse', (app) =>
			app.get(HMR_TRANSPORT_PATHS.sse, (context: any) => context.pluginCtx.ext.sse.stream(context)),
		),
		createInternalPlugin(ctx, 'rpc', (app) =>
			app.all(
					HMR_TRANSPORT_PATHS.rpc,
					async ({ pluginCtx, request, status }: any) => {
						try {
							return await newHttpBatchRpcResponse(request, new HmrRpcApi(pluginCtx))
						} catch (error) {
							pluginCtx.logger.error('RPC request failed', { error })
							return status(500, 'Internal RPC error')
						}
					},
					{ parse: 'none' },
				),
		),
		ctx.internalGraphql.plugin(),
		createInternalPlugin(ctx, 'mcp', (app) =>
			app
				.all(HMR_TRANSPORT_PATHS.mcp, ({ request }: any) => mcpHandler(request), {
					parse: 'none',
				})
				.all(`${HMR_TRANSPORT_PATHS.mcp}/*`, ({ request }: any) => mcpHandler(request), {
					parse: 'none',
				}),
		),
		createInternalPlugin(ctx, 'meta', (app) => metaRoutes(app as unknown as Parameters<typeof metaRoutes>[0])),
		createInternalPlugin(ctx, 'extensions', (app) =>
			extensionRoutes(app as unknown as Parameters<typeof extensionRoutes>[0]),
		),
		createInternalPlugin(ctx, 'debug', (app) =>
			debugRoutes(app as unknown as Parameters<typeof debugRoutes>[0]),
		),
		createInternalPlugin(ctx, 'logs', (app) => logRoutes(app as unknown as Parameters<typeof logRoutes>[0])),
	]
}

export function createInternalApiPlugin(ctx: PluginContext): BaseElysiaApp {
	let app = applyInternalApiGuard(
		createElysiaApp(ctx, {
			aot: true,
			name: 'pluxel.http.internal',
		}) as unknown as BaseElysiaApp,
	)

	for (const plugin of createInternalTransportPlugins(ctx)) app = app.use(plugin) as BaseElysiaApp

	return app
}

export function createInternalApiRoutes(ctx: PluginContext): ElysiaBoundaryBuilder {
	return () => createInternalApiPlugin(ctx)
}
