// packages/runtime/tests/ui-demos/PluginStatusBadge.ts
// 展示型插件：在宿主公共区域插入 UI（非插件详情页）

import { BasePlugin, Plugin } from '@pluxel/runtime'
import { workbench } from '@pluxel/runtime/workbench'
import { PluginStatusBadgeUi } from './PluginStatusBadge.workbench'

const PluginStatusBadgeWorkbench = workbench.extension({
	contract: PluginStatusBadgeUi,
	entry: workbench.entry(import.meta.url, './PluginStatusBadge/ui/StatusBadge.tsx'),
})

@Plugin()
export class PluginStatusBadge extends BasePlugin {
	private counter = 0

	override async init() {
		this.ctx.workbench.mount(PluginStatusBadgeWorkbench, {
			activity: workbench.bind.events<{ tick: { now: number } }>(({ emit }) => {
				const timer = setInterval(() => emit('tick', { now: Date.now() }), 1_000)
				emit('tick', { now: Date.now() })
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
