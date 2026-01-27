// 演示：两种插件间通信方式（都保持最小实现，便于复制改写）。
//
// 1) EvtChannel（DI 依赖明确、事件更局部）：
//    - 生产者暴露 channel
//    - 消费者通过构造注入生产者并订阅
//
// 2) declare module 事件合同（松耦合、走全局总线）：
//    - 在 Context.Events 里集中声明事件名/参数
//    - 生产者 ctx.emit(...)
//    - 消费者 ctx.on(...)

import { BasePlugin, Plugin } from '@pluxel/hmr'
import { EvtChannel } from '@pluxel/hmr/services'

// -------------------------
// 1) EvtChannel demo
// -------------------------

type TickPayload = { from: string; seq: number; at: number }
type TickEvent = readonly [payload: TickPayload]

@Plugin({ name: 'PluginEventsChannelProducer' })
export class PluginEventsChannelProducer extends BasePlugin {
	readonly channel = new EvtChannel<TickEvent>(this.ctx)
	private seq = 0

	override async init() {
		const timer = setInterval(() => {
			this.seq += 1
			this.channel.emit({
				from: this.ctx.pluginInfo.id,
				seq: this.seq,
				at: Date.now(),
			})
		}, 1000)

		this.ctx.scope.collectEffect(() => clearInterval(timer))
	}
}

@Plugin({ name: 'PluginEventsChannelConsumer' })
export class PluginEventsChannelConsumer extends BasePlugin {
	constructor(private readonly producer: PluginEventsChannelProducer) {
		super()
	}

	override async init() {
		this.producer.channel.on(({ from, seq }) => {
			// Avoid spamming info logs in the demo host; enable debug to observe the stream.
			this.ctx.logger.debug('EvtChannel tick', { from, seq })
		})
	}
}

// -------------------------
// 2) Declared global events demo
// -------------------------

declare module '@pluxel/hmr' {
	namespace Context {
		interface Events {
			'pluxel:demo:bus:tick': [payload: { from: string; seq: number; at: number }]
		}
	}
}

const EVENT_TICK = 'pluxel:demo:bus:tick' as const

@Plugin({ name: 'PluginEventsDeclaredProducer' })
export class PluginEventsDeclaredProducer extends BasePlugin {
	private seq = 0

	override async init() {
		const timer = setInterval(() => {
			this.seq += 1
			this.ctx.emit(EVENT_TICK, {
				from: this.ctx.pluginInfo.id,
				seq: this.seq,
				at: Date.now(),
			})
		}, 1000)

		this.ctx.scope.collectEffect(() => clearInterval(timer))
	}
}

@Plugin({ name: 'PluginEventsDeclaredConsumer' })
export class PluginEventsDeclaredConsumer extends BasePlugin {
	override async init() {
		this.ctx.on(EVENT_TICK, ({ from, seq }) => {
			// Avoid spamming info logs in the demo host; enable debug to observe the stream.
			this.ctx.logger.debug('Declared Events tick', { from, seq })
		})
	}
}
