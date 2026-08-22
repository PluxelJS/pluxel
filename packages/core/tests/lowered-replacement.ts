import type { StandardSchemaV1 } from '@standard-schema/spec'
import {
	Plugin,
	pluginDefinitionAddressOf,
	type PluginConstructor,
	type PluginOptions,
} from '@pluxel/core'
import {
	__setPluginConfig,
	__setPluginDefinition,
	PLUGIN_LOWERING_ABI_VERSION,
} from '../src/toolchain'

export type LowerTestReplacementOptions = Readonly<{
	plugin?: PluginOptions
	requires?: readonly PluginConstructor[]
	optional?: readonly PluginConstructor[]
	config?: Readonly<{
		fieldName: string
		schema: StandardSchemaV1
		source?: string
	}>
}>

/**
 * Models a new module evaluation for an existing canonical export. Production
 * replacement facts always come from the semantic lowering pass.
 */
export function lowerTestReplacement<T extends PluginConstructor>(
	previous: PluginConstructor,
	replacement: T,
	options: LowerTestReplacementOptions = {},
): T {
	Plugin(options.plugin)(replacement)
	__setPluginDefinition(replacement, {
		abiVersion: PLUGIN_LOWERING_ABI_VERSION,
		kind: 'plugin',
		definition: pluginDefinitionAddressOf(previous),
		requires: options.requires?.map(pluginDefinitionAddressOf),
		optional: options.optional?.map(pluginDefinitionAddressOf),
	})
	if (options.config) {
		__setPluginConfig(replacement, {
			abiVersion: PLUGIN_LOWERING_ABI_VERSION,
			fieldName: options.config.fieldName,
			schema: options.config.schema,
			...(options.config.source === undefined ? {} : { source: options.config.source }),
		})
	}
	return replacement
}
