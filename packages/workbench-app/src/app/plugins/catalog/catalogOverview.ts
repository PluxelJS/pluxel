import type { PluginGroup } from '../../../runtime'
import type { PluginStatusEntry } from '../pluginOverview'
import type { GroupConfig, PluginStatuses } from './organizer/types'

export type OverviewSnapshot = {
	statuses: PluginStatuses
	groups: GroupConfig[]
	total: number
	running: number
	disabled: number
}

export const EMPTY_OVERVIEW: OverviewSnapshot = {
	statuses: {},
	groups: [],
	total: 0,
	running: 0,
	disabled: 0,
}

const toStatuses = (entries: readonly (PluginStatusEntry | null | undefined)[] | undefined) => {
	const snapshot: PluginStatuses = {}
	for (const entry of entries ?? []) {
		const id = entry?.id
		if (!id) continue
		const source = entry?.source
		snapshot[id] = {
			id,
			address: entry.address,
			name: entry.label ?? entry.displayName ?? id,
			packageName: source?.packageName ?? undefined,
			version: source?.version ?? undefined,
			tag: source?.tag ?? undefined,
			sourceKind: source?.kind ?? 'unknown',
			moduleId: source?.moduleId ?? null,
			isRunning: Boolean(entry?.isRunning),
			isEnabled: entry?.isEnabled !== false,
		}
	}
	return snapshot
}

const toGroups = (groups: readonly (PluginGroup | null | undefined)[] | undefined) => {
	return (groups ?? []).map((group) => ({
		groupId: group?.groupId ?? '',
		name: group?.name ?? '',
		pluginIds: (group?.nodes ?? []).map((node) => node.route),
	}))
}

export const buildOverview = (args: {
	statuses: readonly (PluginStatusEntry | null | undefined)[] | undefined
	groups: readonly (PluginGroup | null | undefined)[] | undefined
	summary?: { total?: number | null; running?: number | null; disabled?: number | null } | null
}): OverviewSnapshot => {
	const { statuses, groups, summary } = args
	const summaryStatuses = toStatuses(statuses)
	let computedRunning = 0
	let computedDisabled = 0
	for (const entry of Object.values(summaryStatuses)) {
		if (entry?.isRunning) computedRunning += 1
		if (entry?.isEnabled === false) computedDisabled += 1
	}

	const total =
		typeof summary?.total === 'number' ? summary.total : Object.keys(summaryStatuses).length
	const running = typeof summary?.running === 'number' ? summary.running : computedRunning
	const disabled = typeof summary?.disabled === 'number' ? summary.disabled : computedDisabled

	return {
		statuses: summaryStatuses,
		groups: toGroups(groups),
		total,
		running,
		disabled,
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
