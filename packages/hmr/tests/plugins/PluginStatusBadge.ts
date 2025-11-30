// packages/hmr/tests/plugins/PluginStatusBadge.ts
// 示例：简单的状态徽章插件

import { BasePlugin, Plugin } from '@pluxel/core'

@Plugin({ name: 'PluginStatusBadge', type: 'event' })
export class PluginStatusBadge extends BasePlugin {
	private counter = 0

	override async init() {
		// 注册一个简单的 Header 扩展
		this.ctx.extensionService.register({
			pluginName: 'PluginStatusBadge',
			entryPath: './ui/StatusBadge.tsx',
		})

		// 每秒更新计数器
		const timer = setInterval(() => {
			this.counter++
		}, 1000)

		this.ctx.scope.collectEffect(() => {
			clearInterval(timer)
		})

		this.ctx.logger.info('[PluginStatusBadge] Started')
	}

	getCounter() {
		return this.counter
	}
}
