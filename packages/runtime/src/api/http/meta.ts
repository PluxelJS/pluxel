import type { Context as PluginContext } from '@pluxel/core'
import { type AnyElysiaApp } from '../../services/http/elysia'
import { RUNTIME_META_BASE, RUNTIME_TRANSPORT_PATHS } from '../../web/paths'
import { requireWebManagement } from '../../services/web-management/WebManagementService'

function readInternalMeta(
	pluginCtx: PluginContext,
) {
	const web = requireWebManagement(pluginCtx)
	const extensionService = web.ui
	const manifest = extensionService?.getManifest()
	const modules = Array.isArray(manifest?.modules) ? manifest.modules.length : 0
	return {
		service: 'pluxel-runtime' as const,
		ready: true as const,
		sse: {
			namespaces: web.sse.getNamespaces(),
		},
		extensions: {
			version: manifest?.version ?? 0,
			modules,
		},
		transport: RUNTIME_TRANSPORT_PATHS,
	}
}

export const metaRoutes = (app: AnyElysiaApp) =>
	app.get('/', 'Pluxel runtime RPC ready').group(RUNTIME_META_BASE, (meta) =>
		meta
			.get('/', async ({ set, pluginCtx, request }) => {
				set.headers['cache-control'] = 'no-store'
				void request
				return readInternalMeta(pluginCtx)
			})
			.get('/sse', ({ set, pluginCtx }) => {
				set.headers['cache-control'] = 'no-store'
				return { namespaces: requireWebManagement(pluginCtx).sse.getNamespaces() }
			}),
	)
