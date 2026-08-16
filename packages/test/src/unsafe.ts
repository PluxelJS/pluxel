/**
 * Unsafe / low-level exports for specialized tests.
 *
 * DO NOT use these for normal plugin tests — prefer the high-level Host API from `@pluxel/test`.
 * These exist only for cases where you are explicitly testing lowered definition/config facts.
 */

export {
	__definePluginRef,
	__setPluginConfig,
	__setPluginDefinition,
	getPluginConfigDefinition,
	getPluginDefinitionFacts,
	hasPluginDefinitionFacts,
} from '@pluxel/core'
