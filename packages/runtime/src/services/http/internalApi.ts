import type { Context as PluginContext } from '@pluxel/core'

import { workbenchRoutes } from '../../api/http/workbench'
import type { HostElysiaBuilder } from './HttpService'
import { createHostElysiaApp } from './elysia'

type BaseElysiaApp = any
type InternalApiOptions = {
	workbench: boolean
}

function applyInternalArtifactGuard(app: BaseElysiaApp): BaseElysiaApp {
	return app.beforeHandle(async ({ pluginCtx, request, set, status }: any) => {
		const path = new URL(request.url).pathname
		const method = (request.method ?? 'GET').toUpperCase()
		const validation = pluginCtx.internalApiValidation
		if (!validation?.hasValidators()) return undefined
		const result = await validation.check({
			path,
			method,
			url: request.url,
			headers: request.headers,
			request,
		})
		if (result.allow === true) return undefined
		set.headers['cache-control'] = 'no-store'
		set.headers['x-pluxel-internal-blocked'] = '1'
		pluginCtx.logger.warn('Blocked internal artifact request', {
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
	}) as BaseElysiaApp
}

export function createInternalApiPlugin(
	ctx: PluginContext,
	options: InternalApiOptions,
): BaseElysiaApp {
	let app = applyInternalArtifactGuard(
		createHostElysiaApp(ctx, {
			precompile: true,
			name: 'pluxel.http.internal-artifacts',
		}) as unknown as BaseElysiaApp,
	)
	if (options.workbench) app = app.use(workbenchRoutes) as BaseElysiaApp
	return app
}

export function createInternalApiRoutes(
	ctx: PluginContext,
	options: InternalApiOptions,
): HostElysiaBuilder {
	return () => createInternalApiPlugin(ctx, options)
}
