import type { PluginConstructor } from '@pluxel/core'
import { checkPluginDecorator, consumePluginDefinitionCandidate } from '@pluxel/core/internal'

/** Discover concrete exports through Core's semantic admission boundary; aliases are deduplicated. */
export function collectPluginModuleExports(namespace: unknown): readonly PluginConstructor[] {
	if (!namespace || typeof namespace !== 'object')
		throw new TypeError('[host] module loader must return a module namespace')
	const plugins = new Set<PluginConstructor>()
	for (const value of Object.values(namespace)) {
		if (typeof value !== 'function' || !checkPluginDecorator(value)) continue
		const candidate = consumePluginDefinitionCandidate(value as PluginConstructor)
		plugins.add(candidate.implementation)
	}
	return Object.freeze([...plugins])
}
