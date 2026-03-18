import type { AnyElysiaApp } from '../../services/http/elysia'
import { HMR_EXTENSIONS_BASE } from '../../web/paths'
import { extensionModuleParams } from './models'

export const extensionRoutes = (app: AnyElysiaApp) =>
	app.group(HMR_EXTENSIONS_BASE, (extensions) =>
		extensions
			.get('/manifest', ({ set, pluginCtx }) => {
				const extensionService = pluginCtx.ext.ui
				if (!extensionService) {
					return { version: 0, modules: [] }
				}
				set.headers['cache-control'] = 'no-store'
				return extensionService.getManifest()
			})
			.get(
				'/modules/:plugin/:file',
				async ({ params, pluginCtx, set, status }) => {
					const extensionService = pluginCtx.ext.ui
					if (!extensionService) {
						return status(503, 'Extension service not available')
					}
					const pluginName = decodeURIComponent(params.plugin)
					const file = params.file
					const hash = file.endsWith('.mjs') ? file.slice(0, -4) : file
					const code = await extensionService.getModuleSource(pluginName, hash)
					if (!code) {
						return status(404, 'Module not found')
					}
					set.headers['content-type'] = 'application/javascript; charset=utf-8'
					set.headers['cache-control'] = 'public, max-age=31536000, immutable'
					return code
				},
				{
					params: extensionModuleParams,
				},
			)
			.get('/events', (context) => context.pluginCtx.ext.sse.stream(context, ['extensions'])),
	)
