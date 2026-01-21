// packages/hmr/tests/demo/PluginEventsDeclared.ts
// 演示：通过 `declare module "@pluxel/hmr"` 声明全局事件合同（Context.Events），并用 ctx.emit/on 通信。
//
// 特点：
// - 松耦合：监听方不需要注入“事件生产者插件实例”
// - 类型集中：事件名/参数在 Context.Events 里统一管理，避免散落字符串

import { BasePlugin, Plugin } from '@pluxel/hmr'

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
			this.ctx.logger.info('Declared Events tick', { from, seq })
		})
	}
}
