import type { Context as PluginContext } from '@pluxel/core'
import { type AnyElysiaApp } from '../../services/http/elysia'
import { HMR_META_BASE, HMR_TRANSPORT_PATHS } from '../../web/paths'

function readInternalMeta(
	pluginCtx: PluginContext,
) {
	const extensionService = pluginCtx.ext.ui
	const manifest = extensionService?.getManifest()
	const modules = Array.isArray(manifest?.modules) ? manifest.modules.length : 0
	return {
		service: 'pluxel-hmr' as const,
		ready: true as const,
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
				void request
				return readInternalMeta(pluginCtx)
			})
			.get('/sse', ({ set, pluginCtx }) => {
				set.headers['cache-control'] = 'no-store'
				return { namespaces: pluginCtx.ext.sse.getNamespaces() }
			}),
	)
