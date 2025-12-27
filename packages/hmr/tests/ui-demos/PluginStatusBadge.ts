// packages/hmr/tests/plugins/ui-demos/PluginStatusBadge.ts
// 展示型插件：在宿主公共区域插入 UI（非插件详情页）

import { BasePlugin, Plugin } from '@pluxel/core'

@Plugin({ name: 'PluginStatusBadge', type: 'event' })
export class PluginStatusBadge extends BasePlugin {
	private counter = 0

	override async init() {
		// 注册 Header 扩展，强调"非插件页面"的挂载点
		this.ctx.ext.ui.register({
			entryPath: './PluginStatusBadge/ui/StatusBadge.tsx',
		})

		// 简单的计时器，供 UI 徽章显示
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
