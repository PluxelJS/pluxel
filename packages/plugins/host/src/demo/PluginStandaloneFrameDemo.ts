import { BasePlugin, Plugin } from '@pluxel/runtime'
import { ui } from '@pluxel/hmr/plugin'

const standaloneUi = ui('./PluginStandaloneFrameDemo/ui/index.tsx')

/**
 * Demo: standalone frame routes.
 *
 * - UI module registers a route with `frame: 'standalone'`.
 * - Host will navigate to `/ext-standalone/<pluginName>/...` when added to nav.
 */
@Plugin({ name: 'PluginStandaloneFrameDemo' })
export class PluginStandaloneFrameDemo extends BasePlugin {
	override async init() {
		standaloneUi.bind(this.ctx)
		this.ctx.logger.info('ready')
	}
}
