import type { PluginConstructor, PluginDefinitionAddressSnapshot } from '@pluxel/core'
import {
	__setPluginDefinition,
	getPluginDefinitionFacts,
	hasPluginDefinitionFacts,
} from '@pluxel/test/unsafe'

export type LowerTestPluginOptions = Readonly<{
	exportName?: string
	source?: string
	requires?: readonly PluginConstructor[]
	optional?: readonly PluginConstructor[]
	provides?: PluginDefinitionAddressSnapshot
}>

/** Explicit lowering fixture for Plugin classes declared inside test callbacks. */
export function lowerTestPlugin<T extends PluginConstructor>(
	plugin: T,
	options: LowerTestPluginOptions = {},
): T {
	if (hasPluginDefinitionFacts(plugin)) return plugin
	const exportName = options.exportName ?? plugin.name
	__setPluginDefinition(plugin, {
		kind: 'plugin',
		definition: {
			entry: {
				kind: 'source-entry',
				source: options.source ?? `tests/runtime-dynamic/${exportName}.ts`,
			},
			exportName,
		},
		requires: options.requires?.map((required) => getPluginDefinitionFacts(required).definition),
		optional: options.optional?.map((optional) => getPluginDefinitionFacts(optional).definition),
		provides: options.provides,
	})
	return plugin
}

/** Explicit lowering fixture for abstract dependency tokens declared inside tests. */
export function lowerTestAbstract<T extends PluginConstructor>(
	plugin: T,
	options: Pick<LowerTestPluginOptions, 'exportName' | 'source'> = {},
): T {
	if (hasPluginDefinitionFacts(plugin)) return plugin
	const exportName = options.exportName ?? plugin.name
	__setPluginDefinition(plugin, {
		kind: 'abstract',
		definition: {
			entry: {
				kind: 'source-entry',
				source: options.source ?? `tests/runtime-dynamic/${exportName}.ts`,
			},
			exportName,
		},
	})
	return plugin
}
