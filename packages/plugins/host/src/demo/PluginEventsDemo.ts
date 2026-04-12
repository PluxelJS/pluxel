// Read this when:
// - 你需要声明式全局事件总线
// - 你不想再看局部 `EvtChannel`，那部分已经在 `PluginFeatureDepsDemo.ts` 里

import { BasePlugin, Plugin } from '@pluxel/runtime'

declare module '@pluxel/runtime' {
	interface RuntimeEvents {
		'pluxel:demo:bus:tick': [payload: { from: string; seq: number; at: number }]
	}
}

const EVENT_TICK = 'pluxel:demo:bus:tick' as const

@Plugin({ name: 'PluginEventsDeclaredProducer' })
export class PluginEventsDeclaredProducer extends BasePlugin {
	private seq = 0

	override init(): void {
		const timer = setInterval(() => {
			this.seq += 1
			this.ctx.emit(EVENT_TICK, {
				from: this.ctx.pluginInfo.id,
				seq: this.seq,
				at: Date.now(),
			})
		}, 1000)

		this.ctx.effects.defer(() => clearInterval(timer))
	}
}

@Plugin({ name: 'PluginEventsDeclaredConsumer' })
export class PluginEventsDeclaredConsumer extends BasePlugin {
	override init(): void {
		this.ctx.on(EVENT_TICK, ({ from, seq }) => {
			// Avoid spamming info logs in the demo host; enable debug to observe the stream.
			this.ctx.logger.debug('Declared Events tick', { from, seq })
		})
	}
}
