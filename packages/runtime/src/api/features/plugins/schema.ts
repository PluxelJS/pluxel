import * as v from 'valibot'

export const Plugin = v.object({
	__typename: v.literal('Plugin'),
	id: v.string(),
	name: v.string(),
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
