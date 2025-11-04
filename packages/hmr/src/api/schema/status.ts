import * as v from 'valibot'

const lifecycleStages = ['running', 'stopped', 'disabled'] as const

export const PluginStatusEntryLifecycleStage = v.picklist(lifecycleStages)

export const PluginStatusEntry = v.object({
	__typename: v.literal('PluginStatusEntry'),
	name: v.string(),
	isRunning: v.boolean(),
	isEnabled: v.boolean(),
	lifecycleStage: PluginStatusEntryLifecycleStage,
})

export const PluginStatusSummary = v.object({
	__typename: v.literal('PluginStatusSummary'),
	total: v.number(),
	running: v.number(),
	stopped: v.number(),
	disabled: v.number(),
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
	isEnabled: v.nullish(v.boolean()),
	lifecycleStage: v.nullish(PluginStatusEntryLifecycleStage),
	error: v.nullish(v.string()),
})

export const UpdateStatusInput = v.object({
	name: v.string(),
	status: v.picklist(['start', 'stop', 'restart', 'enable', 'disable']),
})
