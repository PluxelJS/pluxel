import * as v from 'valibot'

export const PluginGroupInput = v.object({
	groupId: v.string(),
	name: v.string(),
	pluginIds: v.array(v.string()),
})

export const PluginGroup = v.object({
	__typename: v.literal('PluginGroup'),
	groupId: v.string(),
	name: v.string(),
	pluginIds: v.array(v.string()),
})

export type PluginGroupInputValue = v.InferInput<typeof PluginGroupInput>
export type PluginGroupOutput = v.InferOutput<typeof PluginGroup>
