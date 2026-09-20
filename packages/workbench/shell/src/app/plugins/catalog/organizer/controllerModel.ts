import type { UniqueIdentifier } from '@dnd-kit/core'
import type { GroupConfig } from './types'

export const cid = (containerId: 'ROOT_UNGROUPED' | string) =>
	containerId === 'ROOT_UNGROUPED' ? 'c:ROOT' : (`c:${containerId}` as const)

export const isCid = (id: UniqueIdentifier) => typeof id === 'string' && id.startsWith('c:')

export const fromCid = (id: string): 'ROOT_UNGROUPED' | string =>
	id === 'c:ROOT' ? 'ROOT_UNGROUPED' : id.slice(2)

export const iid = (pluginId: string) => `i:${pluginId}`

export const isIid = (id: UniqueIdentifier) => typeof id === 'string' && id.startsWith('i:')

export const fromIid = (id: string) => id.slice(2)

export const gid = (groupId: string) => `g:${groupId}`

export const isGid = (id: UniqueIdentifier) => typeof id === 'string' && id.startsWith('g:')

export const fromGid = (id: string) => id.slice(2)

export type OrganizerContainers = {
	containerToItems: Map<string, string[]>
	itemToContainer: Map<string, string>
}

export const buildContainers = (
	groups: GroupConfig[],
	ungroupedIds: string[],
): OrganizerContainers => {
	const containerToItems = new Map<string, string[]>([
		[
			'ROOT_UNGROUPED',
			ungroupedIds.filter((id) => !groups.some((group) => group.pluginIds.includes(id))),
		],
	])
	for (const group of groups) containerToItems.set(group.groupId, [...group.pluginIds])

	const itemToContainer = new Map<string, string>()
	for (const [containerId, pluginIds] of containerToItems) {
		for (const pluginId of pluginIds) itemToContainer.set(pluginId, containerId)
	}

	return { containerToItems, itemToContainer }
}
