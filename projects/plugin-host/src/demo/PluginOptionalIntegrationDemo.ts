// Read this when:
// - 你需要把 required Plugin 依赖写成 constructor 参数
// - 你需要用 module-level `definePluginRef<T>()` 表达可选集成
// - 你需要让可选集成的订阅随 consumer effects 自动清理

import {
	BasePlugin,
	definePluginRef,
	EvtChannel,
	formatPluginNodeAddress,
	Plugin,
} from '@pluxel/runtime'

export type TickPayload = {
	from: string
	seq: number
	at: number
}

type TickEvent = readonly [payload: TickPayload]

class PluginLogger {
	constructor(private readonly plugin: BasePlugin) {}

	info(message: string, extra?: Record<string, unknown>) {
		this.plugin.ctx.logger.info(message, {
			plugin: formatPluginNodeAddress(this.plugin.ctx.pluginInfo.nodeAddress),
			...extra,
		})
	}

	debug(message: string, extra?: Record<string, unknown>) {
		this.plugin.ctx.logger.debug(message, {
			plugin: formatPluginNodeAddress(this.plugin.ctx.pluginInfo.nodeAddress),
			...extra,
		})
	}
}

@Plugin({ displayName: 'PluginOptionalIntegrationProvider' })
export class PluginOptionalIntegrationProvider extends BasePlugin {
	readonly channel = new EvtChannel<TickEvent>(this.ctx)
	private seq = 0

	override init(): () => void {
		const timer = setInterval(() => {
			this.seq += 1
			this.channel.emit({
				from: formatPluginNodeAddress(this.ctx.pluginInfo.nodeAddress),
				seq: this.seq,
				at: Date.now(),
			})
		}, 750)
		return () => clearInterval(timer)
	}
}

const OptionalProvider = definePluginRef<PluginOptionalIntegrationProvider>()

@Plugin({ displayName: 'PluginOptionalIntegrationConsumer' })
export class PluginOptionalIntegrationConsumer extends BasePlugin {
	private readonly log = new PluginLogger(this)

	override init(): void {
		this.log.info('consumer init')
		this.plugins.use(OptionalProvider, (provider) => {
			this.log.info('optional provider attached', {
				provider: formatPluginNodeAddress(provider.ctx.pluginInfo.nodeAddress),
			})

			const unsubscribe = provider.channel.on(({ from, seq }) => {
				this.log.debug('optional tick', { from, seq })
			})

			return () => {
				unsubscribe()
				this.log.info('optional provider detached', {
					provider: formatPluginNodeAddress(provider.ctx.pluginInfo.nodeAddress),
				})
			}
		})
	}
}
