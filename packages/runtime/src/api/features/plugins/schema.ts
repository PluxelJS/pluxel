import type {
	PluginDefinitionAddress as PluginDefinitionAddressValue,
	PluginEntryAddress as PluginEntryAddressValue,
	PluginNodeAddress as PluginNodeAddressValue,
} from '@pluxel/core'
import * as v from 'valibot'

// GQLoom cannot turn a GraphQL output union into an input type. Resolvers pass this
// carrier through Core's strict parser before use, which enforces the discriminated shape.
export const PluginEntryAddress = v.object({
	kind: v.string(),
	packageName: v.optional(v.string()),
	sourceSpace: v.optional(v.string()),
	path: v.optional(v.string()),
}) as unknown as v.GenericSchema<PluginEntryAddressValue>

export const PluginDefinitionAddress = v.object({
	entry: PluginEntryAddress,
	exportName: v.string(),
}) as unknown as v.GenericSchema<PluginDefinitionAddressValue>

export const PluginNodeAddress = v.object({
	definition: PluginDefinitionAddress,
	variant: v.picklist(['default', 'fork'] as const),
	forkId: v.optional(v.string()),
}) as unknown as v.GenericSchema<PluginNodeAddressValue>

export const Plugin = v.object({
	__typename: v.literal('Plugin'),
	// GQLens requires an `id` entity key. It is exactly the canonical route, not another ID.
	id: v.string(),
	reference: v.string(),
	route: v.string(),
	displayName: v.string(),
	label: v.string(),
	rootExportName: v.string(),
	address: PluginNodeAddress,
})

export const PluginDetail = v.object({
	__typename: v.literal('PluginDetail'),
	label: v.string(),
	desc: v.string(),
	dependencies: v.array(Plugin),
})

export const PluginCatalog = v.object({
	__typename: v.literal('PluginCatalog'),
})

export type PluginOutput = v.InferOutput<typeof Plugin>
