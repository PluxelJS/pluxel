// Read this when:
// - 你要写插件内 feature 组合
// - 你要做可选依赖、局部事件和 bridge plugin
// - 你想看推荐的“主文件 + shared 文件”拆分

import { BasePlugin, Plugin } from '@pluxel/runtime'
import { EvtChannel } from '@pluxel/runtime/services'
import {
	PluginLoggerFeature,
	reconnectOptionalPair,
	type MsgEvent,
	type TickEvent,
} from './PluginFeatureDeps.shared'

function startChannelFeed<Payload>(
	plugin: BasePlugin,
	intervalMs: number,
	emit: () => Payload,
	push: (payload: Payload) => void,
) {
	const timer = setInterval(() => push(emit()), intervalMs)
	plugin.ctx.effects.defer(() => clearInterval(timer))
}

@Plugin({ name: 'PluginFeatureDepsProvider' })
export class PluginFeatureDepsProvider extends BasePlugin {
	readonly channel = new EvtChannel<TickEvent>(this.ctx)
	private seq = 0

	override init(): void {
		startChannelFeed(
			this,
			750,
			() => {
				this.seq += 1
				return {
					from: this.ctx.pluginInfo.id,
					seq: this.seq,
					at: Date.now(),
				}
			},
			(payload) => this.channel.emit(payload),
		)
	}
}

@Plugin({ name: 'PluginFeatureDepsConsumer' })
export class PluginFeatureDepsConsumer extends BasePlugin {
	readonly log: PluginLoggerFeature = this.features.use(PluginLoggerFeature)

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

@Plugin({ name: 'PluginFeatureBridgeProvider' })
export class PluginFeatureBridgeProvider extends BasePlugin {
	readonly channel = new EvtChannel<MsgEvent>(this.ctx)
	private seq = 0

	override init(): void {
		startChannelFeed(
			this,
			1200,
			() => {
				this.seq += 1
				return {
					from: this.ctx.pluginInfo.id,
					text: `hello#${this.seq}`,
					at: Date.now(),
				}
			},
			(payload) => this.channel.emit(payload),
		)
	}
}

@Plugin({ name: 'PluginFeatureBridgeConsumer' })
export class PluginFeatureBridgeConsumer extends BasePlugin {
	bind(provider: PluginFeatureBridgeProvider): () => void {
		this.ctx.logger.info('bridge bind', {
			by: this.caller?.pluginInfo?.id ?? '<no-caller>',
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
			const state = {
				provider: this.provider,
				consumer: this.consumer,
				unbind: this.unbind,
			}
			reconnectOptionalPair(state, (consumer, provider) => consumer.bind(provider))
			this.unbind = state.unbind
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
