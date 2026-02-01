import { BasePlugin, Plugin } from '@pluxel/hmr'

/**
 * Demo: standalone frame routes.
 *
 * - UI module registers a route with `frame: 'standalone'`.
 * - Host will navigate to `/ext-standalone/<pluginName>/...` when added to nav.
 */
@Plugin({ name: 'PluginStandaloneFrameDemo' })
export class PluginStandaloneFrameDemo extends BasePlugin {
	override async init() {
		this.ctx.ext.ui.register({ entryPath: './PluginStandaloneFrameDemo/ui/index.tsx' })
		this.ctx.logger.info('ready')
	}
}

