import { pluginMethodDecorator } from '@pluxel/core'
import { BaseFeature, BasePlugin, Plugin } from '@pluxel/runtime'

@Plugin({ name: 'KvPlugin' })
export class KvPlugin extends BasePlugin {}

const UseKvId = () => pluginMethodDecorator(KvPlugin, async (_original, kv) => kv.ctx.pluginInfo.id)

class CacheFeature extends BaseFeature {
	@UseKvId()
	async depId() {
		return 'local'
	}
}

@Plugin({
	name: 'PluginFeatureUse',
	dependencies: [KvPlugin],
	features: [CacheFeature],
})
export class PluginFeatureUse extends BasePlugin {
	readonly cache = this.features.use(CacheFeature)
}
