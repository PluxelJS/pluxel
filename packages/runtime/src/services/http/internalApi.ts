import type { Context as PluginContext } from '@pluxel/core'
import { RUNTIME_WORKBENCH_MODELS_BASE, RUNTIME_TRANSPORT_PATHS } from '../../web/paths'
import { newHttpBatchRpcResponse } from 'capnweb'

import { workbenchRoutes } from '../../api/http/workbench'
import { metaRoutes } from '../../api/http/meta'
import { securityRoutes } from '../../api/http/security'
import { debugRoutes } from '../../api/http/debug'
import { logRoutes } from '../../api/http/logs'
import { RuntimeRpcApi } from '../../api/http/rpc/RuntimeRpcApi'
import { requireWorkbench } from '../workbench'
import type { HostElysiaBuilder } from './HttpService'
import { createHostElysiaApp } from './elysia'

type BaseElysiaApp = any
type InternalApiOptions = {
	workbench: boolean
}

function createInternalPlugin(
	ctx: PluginContext,
	name: string,
	build: (app: BaseElysiaApp) => unknown,
): BaseElysiaApp {
	const app = createHostElysiaApp(ctx, {
		precompile: true,
		name: `pluxel.http.internal.${name}`,
	}) as unknown as BaseElysiaApp
	return build(app) as unknown as BaseElysiaApp
}

function applyInternalApiGuard(app: BaseElysiaApp): BaseElysiaApp {
	return app.beforeHandle(async ({ pluginCtx, request, set, status }: any) => {
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
		return undefined
	}) as BaseElysiaApp
}

function createInternalTransportPlugins(
	ctx: PluginContext,
	options: InternalApiOptions,
): BaseElysiaApp[] {
	const plugins: BaseElysiaApp[] = [
		createInternalPlugin(ctx, 'root', (app) => app.get('/', 'Pluxel runtime RPC ready')),
		createInternalPlugin(ctx, 'rpc', (app) =>
			app.all(
				RUNTIME_TRANSPORT_PATHS.rpc,
				{ parse: 'none' },
				async ({ pluginCtx, request, status }: any) => {
					try {
						return await newHttpBatchRpcResponse(request, new RuntimeRpcApi(pluginCtx))
					} catch (error) {
						pluginCtx.logger.error('RPC request failed', { error })
						return status(500, 'Internal RPC error')
					}
				},
			),
		),
		createInternalPlugin(ctx, 'meta', (app) =>
			metaRoutes(app as unknown as Parameters<typeof metaRoutes>[0]),
		),
		createInternalPlugin(ctx, 'security', (app) =>
			securityRoutes(app as unknown as Parameters<typeof securityRoutes>[0]),
		),
		createInternalPlugin(ctx, 'debug', (app) =>
			debugRoutes(app as unknown as Parameters<typeof debugRoutes>[0]),
		),
		createInternalPlugin(ctx, 'logs', (app) =>
			logRoutes(app as unknown as Parameters<typeof logRoutes>[0]),
		),
	]

	if (options.workbench) {
		plugins.push(
			createInternalPlugin(ctx, 'sse', (app) =>
				app.get(RUNTIME_TRANSPORT_PATHS.sse, (context: any) =>
					requireWorkbench(context.pluginCtx).events.stream(context),
				),
			),
		)
		plugins.push(createInternalPlugin(ctx, 'workbench', workbenchRoutes))
		plugins.push(
			createInternalPlugin(ctx, 'workbench-resources', (app) =>
				app.get(
					`${RUNTIME_WORKBENCH_MODELS_BASE}/live-queries/:grantId`,
					async ({ params, pluginCtx, request, set, status }: any) => {
						set.headers['cache-control'] = 'no-store'
						const workbench = requireWorkbench(pluginCtx)
						const ref = workbench.registry.findModel(decodePathParam(params.grantId), 'liveQuery')
						if (!ref) return status(410, { code: 'workbench_grant_expired' })
						try {
							const raw = new URL(request.url).searchParams.get('params')
							return await workbench.liveQueries.loadFor(
								ref.resourceId,
								raw ? JSON.parse(raw) : undefined,
							)
						} catch (error) {
							return status(400, {
								code: 'invalid_live_query',
								message: error instanceof Error ? error.message : String(error),
							})
						}
					},
				),
			),
		)
	}
	return plugins
}

export function createInternalApiPlugin(
	ctx: PluginContext,
	options: InternalApiOptions,
): BaseElysiaApp {
	let app = applyInternalApiGuard(
		createHostElysiaApp(ctx, {
			precompile: true,
			name: 'pluxel.http.internal',
		}) as unknown as BaseElysiaApp,
	)

	for (const plugin of createInternalTransportPlugins(ctx, options))
		app = app.use(plugin) as BaseElysiaApp

	return app
}

export function createInternalApiRoutes(
	ctx: PluginContext,
	options: InternalApiOptions,
): HostElysiaBuilder {
	return () => createInternalApiPlugin(ctx, options)
}

function decodePathParam(value: unknown): string {
	try {
		return decodeURIComponent(String(value ?? '').trim())
	} catch {
		return String(value ?? '').trim()
	}
}
