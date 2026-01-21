// packages/hmr/tests/demo/advanced/DemoForks.ts
// 演示：ForkablePlugin（同一个插件可创建多个实例 / fork）
//
// 玩法（在 UI → 插件 → 依赖注入）：
// - 启用 DemoWorker
// - 再启用 DemoWorkerConsumer
// - 在依赖注入面板里把 DemoWorker 切换为某个 fork（例如 DemoWorker#<id>）

import { BasePlugin, ForkablePlugin, Plugin } from '@pluxel/hmr'

@Plugin({ name: 'DemoWorker' })
export class DemoWorker extends ForkablePlugin {
	override init(): void {
		this.ctx.logger.info('ready', { id: this.ctx.pluginInfo.id })
	}

	work(input: string): string {
		return `[${this.ctx.pluginInfo.id}] ${input}`
	}
}

@Plugin({ name: 'DemoWorkerConsumer' })
export class DemoWorkerConsumer extends BasePlugin {
	constructor(private readonly worker: DemoWorker) {
		super()
	}

	override init(): void {
		this.ctx.logger.info('worker result', {
			consumer: this.ctx.pluginInfo.id,
			worker: this.worker.ctx.pluginInfo.id,
			out: this.worker.work('hello fork'),
		})
	}
}

