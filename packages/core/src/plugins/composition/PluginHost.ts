import type { PluginIdentifier } from '../types'
import type { FeatureHost } from './FeatureHost'

/** Optional integrations with independently managed plugin lifecycle nodes. */
export class PluginHost {
	constructor(private readonly features: FeatureHost<any>) {}

	get<T extends PluginIdentifier>(id: T): InstanceType<T> | undefined {
		return this.features.pluginIntegration(id)
	}

	use<T extends PluginIdentifier>(
		id: T,
		callback: (plugin: InstanceType<T>) => void | (() => void),
	): () => void {
		return this.features.pluginIntegration(id, callback)
	}
}
