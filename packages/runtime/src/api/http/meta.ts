import type { Context as PluginContext } from '@pluxel/core'
import { type AnyElysiaApp } from '../../services/http/elysia'
import { HMR_META_BASE, HMR_TRANSPORT_PATHS } from '../../web/paths'

async function readAuthMeta(pluginCtx: PluginContext, request: Request) {
	const authGuard = pluginCtx.authGuard
	if (!authGuard || !authGuard.isActive()) {
		return {
			enabled: false,
			pluginName: null,
			redirectPath: null,
			authenticated: true,
		}
	}

	const path = new URL(request.url).pathname
	const result = await authGuard.check({
		kind: 'api',
		path,
		method: request.method ?? 'GET',
		url: request.url,
		headers: request.headers,
		request,
	})

	return {
		enabled: true,
		pluginName: authGuard.getActivePluginName() ?? null,
		redirectPath: authGuard.getRedirectPath() ?? null,
		authenticated: result.allow,
	}
}

function readInternalMeta(
	pluginCtx: PluginContext,
	auth: Awaited<ReturnType<typeof readAuthMeta>>,
) {
	const extensionService = pluginCtx.ext.ui
	const manifest = extensionService?.getManifest()
	const modules = Array.isArray(manifest?.modules) ? manifest.modules.length : 0
	return {
		service: 'pluxel-hmr' as const,
		ready: true as const,
		auth,
		sse: {
			namespaces: pluginCtx.ext.sse.getNamespaces(),
		},
		extensions: {
			version: manifest?.version ?? 0,
			modules,
		},
		transport: HMR_TRANSPORT_PATHS,
	}
}

export const metaRoutes = (app: AnyElysiaApp) =>
	app.get('/', 'Pluxel HMR RPC ready').group(HMR_META_BASE, (meta) =>
		meta
			.get('/', async ({ set, pluginCtx, request }) => {
				set.headers['cache-control'] = 'no-store'
				return readInternalMeta(pluginCtx, await readAuthMeta(pluginCtx, request))
			})
			.get('/auth', async ({ set, pluginCtx, request }) => {
				set.headers['cache-control'] = 'no-store'
				return await readAuthMeta(pluginCtx, request)
			})
			.get('/sse', ({ set, pluginCtx }) => {
				set.headers['cache-control'] = 'no-store'
				return { namespaces: pluginCtx.ext.sse.getNamespaces() }
			}),
	)
