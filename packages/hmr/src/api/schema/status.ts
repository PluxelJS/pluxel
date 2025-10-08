import * as v from 'valibot'

export const PluginStatusEntry = v.object({
	__typename: v.literal('PluginStatusEntry'),
	name: v.string(),
	isRunning: v.boolean(),
})

export const PluginStatusSummary = v.object({
	__typename: v.literal('PluginStatusSummary'),
	total: v.number(),
	running: v.number(),
	stopped: v.number(),
})

export const PluginStatusOverview = v.object({
	__typename: v.literal('PluginStatusOverview'),
	statuses: v.array(PluginStatusEntry),
	summary: PluginStatusSummary,
})

export const PluginStatusMutationResult = v.object({
	__typename: v.literal('PluginStatusMutationResult'),
	code: v.string(),
	isRunning: v.nullish(v.boolean()),
	error: v.nullish(v.string()),
})

export const UpdateStatusInput = v.object({
	name: v.string(),
	status: v.picklist(['start', 'stop', 'restart']),
})
