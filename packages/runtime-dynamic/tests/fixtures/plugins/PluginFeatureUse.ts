import { BaseFeature, BasePlugin, Plugin, pluginMethodDecorator } from '@pluxel/runtime'

@Plugin({ name: 'KvPlugin' })
export class KvPlugin extends BasePlugin {}

const UseKvId = () => pluginMethodDecorator(KvPlugin, async (_original, kv) => kv.ctx.pluginInfo.id)

class CacheFeature extends BaseFeature {
	@UseKvId()
	async depId() {
		return 'local'
	}
}

@Plugin({ name: 'PluginFeatureUse' })
export class PluginFeatureUse extends BasePlugin {
	readonly cache = this.features.use(CacheFeature)
}
