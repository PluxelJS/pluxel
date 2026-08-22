// Read this when:
// - 你需要一个 Plugin 明确拥有事件 channel
// - 你需要通过 required constructor dependency 消费另一个 Plugin 的事件

import { BasePlugin, EvtChannel, formatPluginNodeReference, Plugin } from '@pluxel/runtime'

type TickEvent = readonly [payload: { from: string; seq: number; at: number }]

@Plugin()
export class PluginEventsDeclaredProducer extends BasePlugin {
	readonly tick = new EvtChannel<TickEvent>(this.ctx)
	private seq = 0

	override init(): () => void {
		const timer = setInterval(() => {
			this.seq += 1
			this.tick.emit({
				from: formatPluginNodeReference(this.ctx.pluginInfo.nodeAddress),
				seq: this.seq,
				at: Date.now(),
			})
		}, 1000)

		return () => clearInterval(timer)
	}
}

@Plugin()
export class PluginEventsDeclaredConsumer extends BasePlugin {
	constructor(private readonly producer: PluginEventsDeclaredProducer) {
		super()
	}

	override init(): void {
		this.producer.tick.on(({ from, seq }) => {
			// Avoid spamming info logs in the demo host; enable debug to observe the stream.
			this.ctx.logger.debug('Declared Events tick', { from, seq })
		})
	}
}
