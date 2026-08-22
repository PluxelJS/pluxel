import { pluginDefinitionAddressOf, type PluginConstructor } from '@pluxel/core'
import {
	__setPluginDefinition,
	PLUGIN_LOWERING_ABI_VERSION,
	PluginLoweringError,
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
	try {
		pluginDefinitionAddressOf(Plugin)
		return Plugin
	} catch (error) {
		if (!(error instanceof PluginLoweringError) || error.code !== 'plugin_declaration_missing') {
			throw error
		}
	}
	const id = options.id ?? Plugin.name
	__setPluginDefinition(Plugin, {
		abiVersion: PLUGIN_LOWERING_ABI_VERSION,
		kind: 'plugin',
		definition: {
			entry: { kind: 'source-entry', sourceSpace: 'app', path: `pluxel-test:${id}` },
			exportName: 'Plugin',
		},
		requires: options.requires?.map(pluginDefinitionAddressOf),
	})
	return Plugin
}
