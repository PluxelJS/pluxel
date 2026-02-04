// 演示：FeatureHost 的“唯一推荐 API”
//
// 1) this.features.use(FeatureCtor)
//    - 插件内模块化（一个插件实例内同一个 Feature 只构造一次）
//    - 配合 HostBoundFeature，可自动注入宿主实例（不需要手动传 this）
//
// 2) this.features.dep(DepPlugin, cb?)
//    - 跨插件“可选集成”（依赖可能不存在/可能被关闭/可能在下一次 commit 才出现）
//    - 回调在依赖出现/重启(实例变化)时会再执行；依赖消失时会执行 cleanup
//
// 3) BridgePlugin（可选）
//    - 把“连接两个插件”的逻辑提取成第三个插件
//    - 让被集成的插件本体更纯粹（不必内建可选依赖逻辑）

import { BasePlugin, HostBoundFeature, Plugin } from '@pluxel/hmr'
import { EvtChannel } from '@pluxel/hmr/services'

// -------------------------
// 1) HostBoundFeature + use()
// -------------------------

class HostLoggerFeature extends HostBoundFeature<BasePlugin> {
	info(message: string, extra?: Record<string, unknown>) {
		this.ctx.logger.info(message, {
			host: this.host.ctx.pluginInfo.id,
			...extra,
		})
	}

	debug(message: string, extra?: Record<string, unknown>) {
		this.ctx.logger.debug(message, {
			host: this.host.ctx.pluginInfo.id,
			...extra,
		})
	}
}

// -------------------------
// 2) dep(): optional dependency
// -------------------------

type TickEvent = readonly [payload: { from: string; seq: number; at: number }]

@Plugin({ name: 'PluginFeatureDepsProvider' })
export class PluginFeatureDepsProvider extends BasePlugin {
	readonly channel = new EvtChannel<TickEvent>(this.ctx)
	private seq = 0

	override init(): void {
		const timer = setInterval(() => {
			this.seq += 1
			this.channel.emit({
				from: this.ctx.pluginInfo.id,
				seq: this.seq,
				at: Date.now(),
			})
		}, 750)

		this.ctx.effects.defer(() => clearInterval(timer))
	}
}

@Plugin({ name: 'PluginFeatureDepsConsumer' })
export class PluginFeatureDepsConsumer extends BasePlugin {
	readonly log: HostLoggerFeature = this.features.use(HostLoggerFeature) // 自动注入 host：不需要传 this

	override init(): void {
		this.log.info('consumer init')

		this.features.dep(PluginFeatureDepsProvider, (dep) => {
			this.log.info('provider available', { dep: dep.ctx.pluginInfo.id })

			const off = dep.channel.on(({ from, seq }) => {
				// Avoid spamming info logs in the demo host; enable debug to observe the stream.
				this.log.debug('tick', { from, seq })
			})

			return () => {
				off()
				this.log.info('provider unavailable')
			}
		})
	}
}

// -------------------------
// 3) BridgePlugin: keep plugins pure
// -------------------------

type MsgEvent = readonly [payload: { from: string; text: string; at: number }]

@Plugin({ name: 'PluginFeatureBridgeProvider' })
export class PluginFeatureBridgeProvider extends BasePlugin {
	readonly channel = new EvtChannel<MsgEvent>(this.ctx)
	private seq = 0

	override init(): void {
		const timer = setInterval(() => {
			this.seq += 1
			this.channel.emit({
				from: this.ctx.pluginInfo.id,
				text: `hello#${this.seq}`,
				at: Date.now(),
			})
		}, 1200)

		this.ctx.effects.defer(() => clearInterval(timer))
	}
}

@Plugin({ name: 'PluginFeatureBridgeConsumer' })
export class PluginFeatureBridgeConsumer extends BasePlugin {
	bind(provider: PluginFeatureBridgeProvider): () => void {
		this.ctx.logger.info('bridge bind', {
			by: this.ctx.caller?.pluginInfo?.id ?? '<no-caller>',
			provider: provider.ctx.pluginInfo.id,
		})

		const off = provider.channel.on(({ from, text }) => {
			// Avoid spamming info logs in the demo host; enable debug to observe the stream.
			this.ctx.logger.debug('bridge message', { from, text })
		})

		return () => off()
	}
}

@Plugin({ name: 'PluginFeatureBridgePlugin' })
export class PluginFeatureBridgePlugin extends BasePlugin {
	private provider?: PluginFeatureBridgeProvider
	private consumer?: PluginFeatureBridgeConsumer
	private unbind?: () => void

	override init(): void {
		const reconnect = () => {
			if (this.unbind) this.unbind()
			this.unbind = undefined
			if (!this.provider || !this.consumer) return
			this.unbind = this.consumer.bind(this.provider)
		}

		this.features.dep(PluginFeatureBridgeProvider, (dep) => {
			this.provider = dep
			reconnect()
			return () => {
				this.provider = undefined
				reconnect()
			}
		})

		this.features.dep(PluginFeatureBridgeConsumer, (dep) => {
			this.consumer = dep
			reconnect()
			return () => {
				this.consumer = undefined
				reconnect()
			}
		})
	}
}
