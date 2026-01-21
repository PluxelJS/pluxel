// packages/hmr/tests/demo/PluginEventsChannel.ts
// 演示：插件 A 通过 EvtChannel 暴露“强类型事件通道”，插件 B 注入 A 并订阅其事件。
//
// 特点：
// - 事件不走全局总线：更局部、更明确（依赖关系通过 DI 表达）
// - 类型由 ChannelEvents 描述，订阅/emit 都有 TS 校验

import { BasePlugin, Plugin } from '@pluxel/hmr'
import { EvtChannel } from '@pluxel/hmr/services'

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
			// 这里只展示“消费侧逻辑”，不做额外状态管理，保持示例精炼。
			this.ctx.logger.info('EvtChannel tick', { from, seq })
		})
	}
}
