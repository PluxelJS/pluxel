import type { PluginConstructor } from '@pluxel/core'
import {
	__setPluginDefinition,
	getPluginDefinitionFacts,
	hasPluginDefinitionFacts,
} from '@pluxel/test/unsafe'

export type LowerTestPluginOptions = Readonly<{
	id?: string
	requires?: readonly PluginConstructor[]
}>

/**
 * Explicit semantic fixture for test-local classes that cannot be lowered by the
 * module-level Vite pass. Production and ordinary Plugin fixtures must not use it.
 */
export function lowerTestPlugin(
	Plugin: PluginConstructor,
	options: LowerTestPluginOptions = {},
): PluginConstructor {
	if (hasPluginDefinitionFacts(Plugin)) return Plugin
	const id = options.id ?? Plugin.name
	__setPluginDefinition(Plugin, {
		kind: 'plugin',
		definition: {
			entry: { kind: 'source-entry', source: `pluxel-test:${id}` },
			exportName: 'Plugin',
		},
		requires: options.requires?.map((required) => getPluginDefinitionFacts(required).definition),
	})
	return Plugin
}
