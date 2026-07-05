import * as v from 'valibot'

import { Plugin } from '../plugins/schema'

export const PluginStatusEntryLifecycleStage = v.picklist([
	'running',
	'stopped',
	'disabled',
] as const)

export const PluginSourceInfo = v.object({
	__typename: v.literal('PluginSourceInfo'),
	kind: v.picklist(['hmr', 'package', 'unknown'] as const),
	moduleId: v.nullish(v.string()),
	packageName: v.nullish(v.string()),
	version: v.nullish(v.string()),
	tag: v.nullish(v.string()),
})

export const PluginStatus = v.object({
	__typename: v.literal('PluginStatus'),
	isRunning: v.boolean(),
	isEnabled: v.boolean(),
	lifecycleStage: PluginStatusEntryLifecycleStage,
	source: PluginSourceInfo,
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
	plugins: v.array(Plugin),
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
	status: v.picklist(['start', 'stop', 'restart', 'enable', 'enable-persisted', 'disable']),
})
