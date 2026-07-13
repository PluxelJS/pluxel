import type { Context as PluginContext } from '@pluxel/core'
import { type AnyElysiaApp } from '../../services/http/elysia'
import { RUNTIME_META_BASE, RUNTIME_TRANSPORT_PATHS } from '../../web/paths'
import { requireManagement } from '../../services/management'

function readInternalMeta(pluginCtx: PluginContext) {
	const management = requireManagement(pluginCtx)
	const catalog = management.registry.getCatalog()
	const modules = catalog.modules.length
	return {
		service: 'pluxel-runtime' as const,
		ready: true as const,
		sse: {
			namespaces: management.streams.listNamespaces(),
		},
		management: {
			version: catalog.revision,
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
				return { namespaces: requireManagement(pluginCtx).streams.listNamespaces() }
			}),
	)
