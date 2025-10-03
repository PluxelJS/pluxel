import * as v from 'valibot'

export const PluginIdScope = v.object({
	__typename: v.literal('PluginIdScope'),
	name: v.string(),
})

export const PluginScope = v.object({
	__typename: v.literal('PluginScope'),
	name: v.string(),
})

export const PluginDependency = v.object({
	__typename: v.literal('PluginDependency'),
	name: v.string(),
	optional: v.boolean(),
	isRunning: v.boolean(),
})

export const PluginDetail = v.object({
	__typename: v.literal('PluginDetail'),
	name: v.string(),
	desc: v.string(),
	dependencies: v.array(PluginDependency),
})

export type PluginScopeOutput = v.InferOutput<typeof PluginScope>
