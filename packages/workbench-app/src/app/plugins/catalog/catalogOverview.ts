import type { PluginCatalogSection } from '../../../runtime'
import { formatPluginNodeReference, pluginNodeIndexKey } from '@pluxel/core'
import type { PluginStatusEntry } from '../pluginOverview'
import {
	describePluginDefinition,
	describePluginExecution,
	describePluginRecentUpdate,
} from '../pluginExecutionPresentation'
import type { GroupConfig, PluginStatuses } from './organizer/types'

export type OverviewSnapshot = {
	statuses: PluginStatuses
	groups: GroupConfig[]
	total: number
	statusCounts: StatusCounts
}

export type StatusCounts = {
	running: number
	stopped: number
	unavailable: number
}

export const EMPTY_OVERVIEW: OverviewSnapshot = {
	statuses: {},
	groups: [],
	total: 0,
	statusCounts: {
		running: 0,
		stopped: 0,
		unavailable: 0,
	},
}

const toStatuses = (entries: readonly (PluginStatusEntry | null | undefined)[] | undefined) => {
	const snapshot: PluginStatuses = {}
	for (const entry of entries ?? []) {
		const id = entry?.id
		if (!id) continue
		const definition = describePluginDefinition(entry.address.definition)
		const execution = describePluginExecution(entry.execution)
		const recentUpdate = describePluginRecentUpdate(entry.recentUpdate)
		const hasRecentUpdateWarning = recentUpdate.warning
		snapshot[id] = {
			id,
			address: entry.address,
			reference: formatPluginNodeReference(entry.address),
			name: entry.label ?? entry.displayName ?? id,
			definitionLabel: definition.compactLabel,
			packageName: definition.packageName ?? undefined,
			sourceSpace: definition.sourceSpace ?? undefined,
			sourcePath: definition.path ?? undefined,
			exportName: definition.exportName,
			executionLabel: execution.badgeLabel,
			executionTone: execution.badgeTone,
			executionDescription: `${execution.currentLabel} · ${execution.artifactLabel}；${execution.updateLabel}`,
			executionSearchTerms: execution.searchTerms,
			recentUpdateSearchTerms: recentUpdate.searchTerms,
			recentUpdateWarningLabel: hasRecentUpdateWarning ? recentUpdate.label : undefined,
			recentUpdateWarningTone: hasRecentUpdateWarning ? recentUpdate.tone : undefined,
			recentUpdateWarningDescription: hasRecentUpdateWarning
				? `${recentUpdate.label}${recentUpdate.meta ? ` · ${recentUpdate.meta}` : ''}`
				: undefined,
			availability: entry.availability,
			autoStart: entry.autoStart,
			desiredState: entry.desiredState,
			lifecycleState: entry.lifecycleState,
		}
	}
	return snapshot
}

const toGroups = (
	sections: readonly (PluginCatalogSection | null | undefined)[] | undefined,
	statuses: PluginStatuses,
) => {
	const idsByAddress = new Map(
		Object.values(statuses).map((status) => [pluginNodeIndexKey(status.address), status.id]),
	)
	return (sections ?? []).map((section) => ({
		groupId: section?.sectionId ?? '',
		name: section?.name ?? '',
		pluginIds: (section?.nodes ?? []).map((address) => {
			const id = idsByAddress.get(pluginNodeIndexKey(address))
			if (!id) throw new Error('Plugin catalog section references an unknown Plugin node')
			return id
		}),
	}))
}

export const buildOverview = (args: {
	statuses: readonly (PluginStatusEntry | null | undefined)[] | undefined
	sections: readonly (PluginCatalogSection | null | undefined)[] | undefined
	summary?: { total?: number | null } | null
}): OverviewSnapshot => {
	const { statuses, sections, summary } = args
	const summaryStatuses = toStatuses(statuses)
	const statusCounts: StatusCounts = { running: 0, stopped: 0, unavailable: 0 }
	for (const entry of Object.values(summaryStatuses)) {
		if (entry.availability === 'unavailable') {
			statusCounts.unavailable += 1
		} else if (entry.lifecycleState === 'running') {
			statusCounts.running += 1
		} else {
			statusCounts.stopped += 1
		}
	}

	const total =
		typeof summary?.total === 'number' ? summary.total : Object.keys(summaryStatuses).length

	return {
		statuses: summaryStatuses,
		groups: toGroups(sections, summaryStatuses),
		total,
		statusCounts,
	}
}

export const cloneGroups = (input: GroupConfig[]): GroupConfig[] =>
	input.map((group) => ({
		groupId: group.groupId,
		name: group.name,
		pluginIds: [...group.pluginIds],
	}))

export const areGroupsEqual = (a: GroupConfig[], b: GroupConfig[]) => {
	if (a.length !== b.length) return false
	for (let i = 0; i < a.length; i += 1) {
		const ga = a[i]
		const gb = b[i]
		if (!gb) return false
		if (ga.groupId !== gb.groupId || ga.name !== gb.name) return false
		if (ga.pluginIds.length !== gb.pluginIds.length) return false
		for (let j = 0; j < ga.pluginIds.length; j += 1) {
			if (ga.pluginIds[j] !== gb.pluginIds[j]) return false
		}
	}
	return true
}
