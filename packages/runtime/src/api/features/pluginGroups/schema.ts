import * as v from 'valibot'
import { PluginNodeAddress } from '../plugins/schema'

export const PluginGroupNode = v.object({
	__typename: v.literal('PluginGroupNode'),
	// GQLens entity key; equal to `route`.
	id: v.string(),
	reference: v.string(),
	route: v.string(),
	displayName: v.string(),
	label: v.string(),
	rootExportName: v.string(),
	address: PluginNodeAddress,
})

export const PluginGroupInput = v.object({
	groupId: v.string(),
	name: v.string(),
	nodes: v.array(PluginNodeAddress),
})

export const PluginGroup = v.object({
	__typename: v.literal('PluginGroup'),
	id: v.string(),
	groupId: v.string(),
	name: v.string(),
	nodes: v.array(PluginGroupNode),
})

export type PluginGroupInputValue = v.InferInput<typeof PluginGroupInput>
export type PluginGroupOutput = v.InferOutput<typeof PluginGroup>
