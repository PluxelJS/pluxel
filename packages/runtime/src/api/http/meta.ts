import type { Context as PluginContext } from '@pluxel/core'
import { type AnyElysiaApp } from '../../services/http/elysia'
import { RUNTIME_META_BASE, RUNTIME_TRANSPORT_PATHS } from '../../web/paths'
import { requireWorkbench } from '../../services/workbench'

function readInternalMeta(pluginCtx: PluginContext) {
	const workbench = requireWorkbench(pluginCtx)
	const catalog = workbench.registry.getCatalog()
	const bundles = catalog.bundles.length
	return {
		service: 'pluxel-runtime' as const,
		ready: true as const,
		application: workbench.application,
		sse: {
			namespaces: workbench.events.listNamespaces(),
		},
		workbench: {
			version: catalog.revision,
			bundles,
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
				return { namespaces: requireWorkbench(pluginCtx).events.listNamespaces() }
			}),
	)
