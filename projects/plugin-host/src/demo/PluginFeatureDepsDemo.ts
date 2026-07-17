// Read this when:
// - 你要写插件内 feature 组合
// - 你要区分 required feature 和 lazy feature
// - 你想看 `defineLazyFeature(...)` + `load(...)` + 懒加载 optional module 的标准写法
// - 你想确认 “依赖插件类型存在” 和 “依赖插件包可能根本不存在” 该怎么分别表达

import { BasePlugin, defineLazyFeature, EvtChannel, Plugin } from '@pluxel/runtime'
import { PluginLoggerFeature, type TickEvent } from './PluginFeatureDeps.shared'

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

const providerMonitorFeature = defineLazyFeature({
	key: 'provider-monitor',
	// 这里用类 token，是因为 provider plugin 与 host demo 在同一个静态代码面里，
	// 可以安全地被宿主直接 import。
	// 如果 provider 包本身可能不存在，就不要在 host 文件 import 它的类；
	// 改为 `requires: ['acme.provider']` 这类稳定字符串标识，并把 provider-specific
	// 代码留在 load() 对应的懒加载模块里。
	requires: [PluginFeatureDepsProvider],
	load: () =>
		import('./PluginFeatureDeps.optional').then(
			({ PluginFeatureProviderMonitorFeature }) => PluginFeatureProviderMonitorFeature,
		),
})

@Plugin({ name: 'PluginFeatureDepsConsumer', features: [PluginLoggerFeature] })
export class PluginFeatureDepsConsumer extends BasePlugin {
	readonly log: PluginLoggerFeature = this.features.use(PluginLoggerFeature)

	override async init(): Promise<void> {
		this.log.info('consumer init')
		const monitor = await this.features.load(providerMonitorFeature)
		this.log.info(monitor ? 'optional monitor enabled' : 'optional monitor skipped')
	}
}
