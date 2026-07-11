// Advanced: read this when:
// - 你需要同一个插件的多个运行实例
// - 你要看 consumer 如何依赖某个 fork

import { BasePlugin, ForkablePlugin, Plugin } from '@pluxel/runtime'

@Plugin({ name: 'DemoWorker' })
export class DemoWorker extends ForkablePlugin {
	override init(): void {
		this.ctx.logger.info('ready', { id: this.ctx.pluginInfo.id })
	}

	work(input: string): string {
		return `[${this.ctx.pluginInfo.id}] ${input}`
	}
}

@Plugin({ name: 'DemoWorkerConsumer', dependencies: [DemoWorker] })
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
