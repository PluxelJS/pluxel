import * as v from 'valibot'

export const PluginDefinitionAddress = v.object({
	entry: v.object({
		kind: v.string(),
		packageName: v.optional(v.string()),
		source: v.optional(v.string()),
	}),
	exportName: v.string(),
})

export const PluginNodeAddress = v.object({
	definition: PluginDefinitionAddress,
	instance: v.string(),
	forkId: v.optional(v.string()),
})

export const Plugin = v.object({
	__typename: v.literal('Plugin'),
	id: v.string(),
	name: v.string(),
	rootExportName: v.string(),
	address: PluginNodeAddress,
})

export const PluginDetail = v.object({
	__typename: v.literal('PluginDetail'),
	name: v.string(),
	desc: v.string(),
	dependencies: v.array(Plugin),
})

export const PluginCatalog = v.object({
	__typename: v.literal('PluginCatalog'),
})

export type PluginOutput = v.InferOutput<typeof Plugin>
