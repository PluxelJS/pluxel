import type { Context as PluginContext } from '@pluxel/core'
import { type AnyElysiaApp } from '../../services/http/elysia'
import { RUNTIME_META_BASE } from '../../web/paths'

function readInternalMeta(pluginCtx: PluginContext) {
	const management = pluginCtx.root.runtimeManagement
	if (!management) throw new Error('[pluxel/runtime] Management discovery is not installed')
	return management.describe()
}

export const metaRoutes = (app: AnyElysiaApp) =>
	app.get('/', 'Pluxel runtime RPC ready').group(RUNTIME_META_BASE, (meta) =>
		meta.get('/', ({ set, pluginCtx }) => {
			set.headers['cache-control'] = 'no-store'
			return readInternalMeta(pluginCtx)
		}),
	)
