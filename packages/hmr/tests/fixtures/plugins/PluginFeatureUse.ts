import { BaseFeature, BasePlugin, Plugin, pluginMethodDecorator } from '@pluxel/hmr'

@Plugin({ name: 'KvPlugin' })
export class KvPlugin extends BasePlugin {}

const UseKvId = () =>
	pluginMethodDecorator(KvPlugin, async function (_original, kv) {
		return kv.ctx.pluginInfo.id
	})

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
