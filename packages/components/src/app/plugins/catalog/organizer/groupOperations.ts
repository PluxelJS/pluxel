import type { GroupConfig } from './types'

export const getPluginOrder = (groups: GroupConfig[], ungroupedOrder: string[]) => {
	const ordered: string[] = [...ungroupedOrder]
	for (const group of groups) ordered.push(...group.pluginIds)
	return ordered
}

export const sortPluginIdsByOrder = (
	pluginIds: string[],
	groups: GroupConfig[],
	ungroupedOrder: string[],
) => {
	const order = getPluginOrder(groups, ungroupedOrder)
	const rank = new Map(order.map((id, index) => [id, index]))
	return [...pluginIds].sort(
		(left, right) =>
			(rank.get(left) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right) ?? Number.MAX_SAFE_INTEGER),
	)
}

export const movePluginIdsToTarget = ({
	groups,
	ungroupedOrder,
	pluginIds,
	targetGroupId,
}: {
	groups: GroupConfig[]
	ungroupedOrder: string[]
	pluginIds: string[]
	targetGroupId: string | 'ROOT_UNGROUPED'
}) => {
	const movingSet = new Set(pluginIds)
	const cleanedGroups = groups.map((group) => ({
		...group,
		pluginIds: group.pluginIds.filter((id) => !movingSet.has(id)),
	}))
	const cleanedUngrouped = ungroupedOrder.filter((id) => !movingSet.has(id))

	if (targetGroupId === 'ROOT_UNGROUPED') {
		return {
			groups: cleanedGroups,
			ungroupedOrder: [...cleanedUngrouped, ...pluginIds],
		}
	}

	return {
		groups: cleanedGroups.map((group) =>
			group.groupId === targetGroupId
				? { ...group, pluginIds: [...group.pluginIds, ...pluginIds] }
				: group,
		),
		ungroupedOrder: cleanedUngrouped,
	}
}
