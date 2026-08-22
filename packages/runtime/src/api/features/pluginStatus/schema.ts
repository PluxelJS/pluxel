import * as v from 'valibot'

import { Plugin } from '../plugins/schema'

export const PluginStatusEntryLifecycleStage = v.picklist([
	'running',
	'stopped',
	'disabled',
] as const)

export const PluginStatusAvailability = v.picklist(['available', 'unavailable'] as const)

export const PluginStatusIssue = v.object({
	__typename: v.literal('PluginStatusIssue'),
	// Reconciliation semantic key; the same issue keeps one entity identity in every owner list.
	id: v.string(),
	code: v.picklist([
		'consumer_unavailable',
		'requirement_removed',
		'provider_unavailable',
		'provider_disabled',
		'provider_incompatible',
		'fork_not_allowed',
		'fork_default_forbidden',
		'provider_default_requires_abstract',
		'explicit_binding_invalid',
		'missing_required_provider',
		'definition_unavailable',
	] as const),
	message: v.string(),
})

// GraphQL needs one uniquely named object type. The runtime projection keeps the
// narrower kind-specific union; this carrier exposes its common nullable shape.
export const PluginSourceInfo = v.object({
	__typename: v.literal('PluginSourceInfo'),
	kind: v.picklist(['package', 'hmr', 'unknown'] as const),
	moduleId: v.nullable(v.string()),
	packageName: v.nullable(v.string()),
	version: v.nullable(v.string()),
	tag: v.nullable(v.string()),
})

export const PluginStatus = v.object({
	__typename: v.literal('PluginStatus'),
	isRunning: v.boolean(),
	isEnabled: v.boolean(),
	lifecycleStage: PluginStatusEntryLifecycleStage,
	availability: PluginStatusAvailability,
	issues: v.array(PluginStatusIssue),
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
