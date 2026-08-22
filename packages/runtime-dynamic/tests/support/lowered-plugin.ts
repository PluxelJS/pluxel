import {
	pluginDefinitionAddressOf,
	type PluginConstructor,
	type PluginDefinitionAddress,
} from '@pluxel/core'
import {
	__setPluginDefinition,
	PLUGIN_LOWERING_ABI_VERSION,
	PluginLoweringError,
} from '@pluxel/test/unsafe'

export type LowerTestPluginOptions = Readonly<{
	exportName?: string
	sourceSpace?: string
	path?: string
	requires?: readonly PluginConstructor[]
	optional?: readonly PluginConstructor[]
	provides?: PluginDefinitionAddress
}>

/** Explicit lowering fixture for Plugin classes declared inside test callbacks. */
export function lowerTestPlugin<T extends PluginConstructor>(
	plugin: T,
	options: LowerTestPluginOptions = {},
): T {
	if (hasLoweredAddress(plugin)) return plugin
	const exportName = options.exportName ?? plugin.name
	__setPluginDefinition(plugin, {
		abiVersion: PLUGIN_LOWERING_ABI_VERSION,
		kind: 'plugin',
		definition: {
			entry: {
				kind: 'source-entry',
				sourceSpace: options.sourceSpace ?? 'app',
				path: options.path ?? `tests/runtime-dynamic/${exportName}.ts`,
			},
			exportName,
		},
		requires: options.requires?.map(pluginDefinitionAddressOf),
		optional: options.optional?.map(pluginDefinitionAddressOf),
		provides: options.provides,
	})
	return plugin
}

/** Explicit HMR fixture: a new constructor generation at an existing definition address. */
export function lowerTestReplacement<T extends PluginConstructor>(
	previous: PluginConstructor,
	replacement: T,
	options: Pick<LowerTestPluginOptions, 'requires' | 'optional' | 'provides'> = {},
): T {
	__setPluginDefinition(replacement, {
		abiVersion: PLUGIN_LOWERING_ABI_VERSION,
		kind: 'plugin',
		definition: pluginDefinitionAddressOf(previous),
		requires: options.requires?.map(pluginDefinitionAddressOf),
		optional: options.optional?.map(pluginDefinitionAddressOf),
		provides: options.provides,
	})
	return replacement
}

/** Explicit lowering fixture for abstract dependency tokens declared inside tests. */
export function lowerTestAbstract<T extends PluginConstructor>(
	plugin: T,
	options: Pick<LowerTestPluginOptions, 'exportName' | 'sourceSpace' | 'path'> = {},
): T {
	if (hasLoweredAddress(plugin)) return plugin
	const exportName = options.exportName ?? plugin.name
	__setPluginDefinition(plugin, {
		abiVersion: PLUGIN_LOWERING_ABI_VERSION,
		kind: 'abstract',
		definition: {
			entry: {
				kind: 'source-entry',
				sourceSpace: options.sourceSpace ?? 'app',
				path: options.path ?? `tests/runtime-dynamic/${exportName}.ts`,
			},
			exportName,
		},
	})
	return plugin
}

function hasLoweredAddress(plugin: PluginConstructor): boolean {
	try {
		pluginDefinitionAddressOf(plugin)
		return true
	} catch (error) {
		if (error instanceof PluginLoweringError && error.code === 'plugin_declaration_missing') {
			return false
		}
		throw error
	}
}
