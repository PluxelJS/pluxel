// packages/hmr/tests/plugins/PluginWithUI.ts
// 示例：带有 UI 扩展的插件

import { BasePlugin, Plugin } from '@pluxel/core'

@Plugin({ name: 'PluginWithUI', type: 'event' })
export class PluginWithUI extends BasePlugin {
	override async init() {
		this.ctx.logger.info('[PluginWithUI] Initializing...')

		// 注册 UI 扩展入口，实际扩展在入口模块内声明
		this.ctx.extensionService.register({
			pluginName: 'PluginWithUI',
			entryPath: './ui/index.tsx',
		})

		this.ctx.logger.info('[PluginWithUI] UI extensions registered')
	}

	override async stop() {
		this.ctx.logger.info('[PluginWithUI] Stopping...')
	}

	getStatus() {
		return {
			status: 'running',
			uptime: Date.now(),
		}
	}
}
