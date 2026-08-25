/**
 * Unsafe / low-level exports for specialized tests.
 *
 * DO NOT use these for normal plugin tests — prefer the high-level Host API from `@pluxel/test`.
 * These exist only for cases where you are explicitly testing lowered definition/config facts.
 */

import {
	Plugin,
	pluginDefinitionAddressOf,
	type PluginConstructor,
	type PluginOptions,
	type PluginToken,
} from '@pluxel/core'
import { __setPluginDefinition, PLUGIN_LOWERING_ABI_VERSION } from '@pluxel/core/toolchain'

export type LowerTestReplacementOptions = Readonly<{
	/** Marker facts owned by this replacement evaluation. */
	plugin?: PluginOptions
	/** Direct constructor requirements; aggregate graph edges are derived during ingestion. */
	requires?: readonly PluginToken[]
	/** Optional edges owned by this replacement evaluation. */
	optional?: readonly PluginToken[]
	/** Abstract capability published by this replacement evaluation. */
	provides?: PluginToken
}>

/**
 * Model a fresh semantic evaluation of an existing canonical Plugin export.
 *
 * The replacement class must be undecorated and must not already have lowering facts. This helper
 * deliberately writes the target definition address onto the candidate itself; RuntimeHost never
 * rewrites a foreign candidate or clones facts from the previous implementation.
 */
export function lowerTestReplacement<T extends PluginConstructor>(
	previous: PluginConstructor,
	replacement: T,
	options: LowerTestReplacementOptions = {},
): T {
	if (options.provides) Plugin(options.provides, options.plugin)(replacement)
	else Plugin(options.plugin)(replacement)
	__setPluginDefinition(replacement, {
		abiVersion: PLUGIN_LOWERING_ABI_VERSION,
		kind: 'plugin',
		definition: pluginDefinitionAddressOf(previous),
		constructorRequires: options.requires?.map(pluginDefinitionAddressOf),
		optional: options.optional?.map(pluginDefinitionAddressOf),
		...(options.provides === undefined
			? {}
			: { provides: pluginDefinitionAddressOf(options.provides) }),
	})
	return replacement
}

export {
	__definePluginRef,
	__setPluginConfig,
	__setPluginDefinition,
	__setPluginPartConfig,
	__setPluginPartOptional,
	__setPluginPartRequires,
	__setPluginParts,
	PLUGIN_LOWERING_ABI_VERSION,
	PluginLoweringError,
} from '@pluxel/core/toolchain'
export { consumePluginDefinitionCandidate } from '@pluxel/core/internal'
export type { ConcretePluginDefinitionCandidate } from '@pluxel/core/internal'
