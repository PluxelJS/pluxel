// Advanced: read this when:
// - 你需要同一个插件的多个运行实例
// - 你要看 consumer 如何依赖某个 fork

import { BasePlugin, formatPluginNodeAddress, ForkablePlugin, Plugin } from '@pluxel/runtime'

@Plugin()
export class DemoWorker extends ForkablePlugin {
	override init(): void {
		this.ctx.logger.info('ready', {
			address: formatPluginNodeAddress(this.ctx.pluginInfo.nodeAddress),
		})
	}

	work(input: string): string {
		return `[${formatPluginNodeAddress(this.ctx.pluginInfo.nodeAddress)}] ${input}`
	}
}

@Plugin()
export class DemoWorkerConsumer extends BasePlugin {
	constructor(private readonly worker: DemoWorker) {
		super()
	}

	override init(): void {
		this.ctx.logger.info('worker result', {
			consumer: formatPluginNodeAddress(this.ctx.pluginInfo.nodeAddress),
			worker: formatPluginNodeAddress(this.worker.ctx.pluginInfo.nodeAddress),
			out: this.worker.work('hello fork'),
		})
	}
}
