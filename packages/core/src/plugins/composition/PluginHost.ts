import type { PluginConstructor, PluginIdentifier } from '../types'
import type { FeatureHost } from './FeatureHost'
import { isOptionalPluginRef, type OptionalPluginRef } from './OptionalPlugin'

type OptionalPluginAvailability = {
	subscribe<T extends PluginConstructor>(
		ref: OptionalPluginRef<T>,
		onResolved: (token: T) => void,
	): () => void
}

/** Optional integrations with independently managed plugin lifecycle nodes. */
export class PluginHost {
	constructor(private readonly features: FeatureHost<any>) {}

	get<T extends PluginIdentifier>(id: T): InstanceType<T> | undefined {
		return this.features.pluginIntegration(id)
	}

	use<T extends PluginIdentifier>(
		id: T,
		callback: (plugin: InstanceType<T>) => void | (() => void),
	): () => void
	use<T extends PluginConstructor>(
		ref: OptionalPluginRef<T>,
		callback: (plugin: InstanceType<T>) => void | (() => void),
	): () => void
	use(
		target: PluginIdentifier | OptionalPluginRef<PluginConstructor>,
		callback: (plugin: any) => void | (() => void),
	): () => void {
		if (!isOptionalPluginRef(target)) return this.features.pluginIntegration(target, callback)

		const availability = (this.features.ctx.root as unknown as { optionalPlugins?: unknown })
			.optionalPlugins as OptionalPluginAvailability | undefined
		if (!availability) {
			throw new Error(
				'[pluxel/core] package-optional plugins require a runtime availability service',
			)
		}

		let stopWatching: (() => void) | undefined
		const stopAvailability = availability.subscribe(target, (token) => {
			stopWatching?.()
			stopWatching = this.features.pluginIntegration(token, callback)
		})
		const off = () => {
			stopWatching?.()
			stopWatching = undefined
			stopAvailability()
		}
		this.features.ctx.effects.defer(off)
		return off
	}
}
