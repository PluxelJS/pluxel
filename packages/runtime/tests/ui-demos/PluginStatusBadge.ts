// packages/runtime/tests/ui-demos/PluginStatusBadge.ts
// 展示型插件：在宿主公共区域插入 UI（非插件详情页）

import { BasePlugin, Plugin } from '@pluxel/runtime'
import { managementBinding } from '@pluxel/runtime/management'
import { PluginStatusBadgeManagement } from './PluginStatusBadge.management'

@Plugin({ name: 'PluginStatusBadge', type: 'event' })
export class PluginStatusBadge extends BasePlugin {
	private counter = 0

	override async init() {
		this.ctx.management.mount(PluginStatusBadgeManagement, {
			activity: managementBinding.stream((channel) => {
				const timer = setInterval(() => channel.emit('tick', { now: Date.now() }), 1_000)
				channel.emit('tick', { now: Date.now() })
				return () => clearInterval(timer)
			}),
		})

		// 简单的计时器，供 UI 徽章显示
		const timer = setInterval(() => {
			this.counter++
		}, 1000)

		this.ctx.effects.defer(() => {
			clearInterval(timer)
		})

		this.ctx.logger.info('Started')
	}

	getCounter() {
		return this.counter
	}
}
