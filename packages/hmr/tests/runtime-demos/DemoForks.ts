import { BasePlugin, ForkablePlugin, Plugin } from '@pluxel/core'

/**
 * Demo: forkable plugins + dependency fork selection.
 *
 * - Enable DemoWorker
 * - Enable DemoWorkerConsumer
 * - In UI: Plugin → 依赖注入 → (Fork) DemoWorker → 选择 DemoWorker#<id> 或创建 Fork
 */
@Plugin({ name: 'DemoWorker', type: 'demo' })
export class DemoWorker extends ForkablePlugin {
	override init(): void {
		this.ctx.logger.info({ id: this.ctx.pluginInfo.id }, '[DemoWorker] ready')
	}

	ping(): string {
		return `pong from ${this.ctx.pluginInfo.id}`
	}
}

@Plugin({ name: 'DemoWorkerConsumer', type: 'demo' })
export class DemoWorkerConsumer extends BasePlugin {
	constructor(private worker: DemoWorker) {
		super()
	}

	override init(): void {
		this.ctx.logger.info(
			{
				consumer: this.ctx.pluginInfo.id,
				worker: this.worker.ctx.pluginInfo.id,
				ping: this.worker.ping(),
			},
			'[DemoWorkerConsumer] injected worker',
		)
	}
}

