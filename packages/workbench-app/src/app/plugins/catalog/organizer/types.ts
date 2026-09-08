import type { PluginNodeAddress } from '@pluxel/core'
import type { PluginPresentationTone } from '../../pluginExecutionPresentation'

export type PluginStatuses = { [name: string]: PluginStatus }

export interface PluginStatus {
	failureLabel?: string
	failureDescription?: string
	id: string
	address: PluginNodeAddress
	reference: string
	name?: string
	definitionLabel: string
	packageName?: string
	sourceSpace?: string
	sourcePath?: string
	exportName: string
	executionLabel: string
	executionTone: PluginPresentationTone
	executionDescription: string
	executionSearchTerms: readonly string[]
	recentUpdateSearchTerms: readonly string[]
	recentUpdateWarningLabel?: string
	recentUpdateWarningTone?: PluginPresentationTone
	recentUpdateWarningDescription?: string
	availability: 'available' | 'unavailable'
	autoStart: boolean
	desiredState: 'running' | 'stopped'
	lifecycleState: 'running' | 'stopped'
}

export interface GroupConfig {
	groupId: string
	name: string
	pluginIds: string[]
}
