// Read this when:
// - 你想看 `load(...)` 对应的 lazy feature 模块
// - 你想看 “先判定依赖，再懒加载 feature” 的最小写法
// - 你想看 lazy feature 启用后，如何继续用 `dep(...)` 做运行期协作

import { BasePlugin, HostBoundFeature } from '@pluxel/runtime'
import { PluginFeatureDepsProvider } from './PluginFeatureDepsDemo'

export class PluginFeatureProviderMonitorFeature extends HostBoundFeature<BasePlugin> {
	constructor(ctx: BasePlugin['ctx'], host: BasePlugin) {
		super(ctx, host)

		// `load()` 只决定这个 feature 要不要存在；
		// provider 后续的出现/消失与解绑，继续交给 `dep(...)`。
		const off = this.host.plugins.use(PluginFeatureDepsProvider, (dep) => {
			this.ctx.logger.info('lazy feature attached', {
				host: this.host.ctx.pluginInfo.id,
				provider: dep.ctx.pluginInfo.id,
			})

			const unbind = dep.channel.on(({ from, seq }) => {
				this.ctx.logger.debug('optional tick', {
					host: this.host.ctx.pluginInfo.id,
					from,
					seq,
				})
			})

			return () => {
				unbind()
				this.ctx.logger.info('lazy feature detached', {
					host: this.host.ctx.pluginInfo.id,
					provider: dep.ctx.pluginInfo.id,
				})
			}
		})

		this.effects.defer(off)
	}
}
