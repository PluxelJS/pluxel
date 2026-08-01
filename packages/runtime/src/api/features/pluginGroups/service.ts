import type { Context as PlxContext } from '@pluxel/core'
import { GraphQLError } from 'graphql'

import { requireWorkbench } from '../../../services/workbench'
import type { PluginGroupInputValue, PluginGroupOutput } from './schema'

export async function readGroups(pCtx: PlxContext): Promise<PluginGroupOutput[]> {
	const groups = await requireWorkbench(pCtx).pluginCatalog.listGroups()
	return groups.map(toOutput)
}

export async function readGroup(pCtx: PlxContext, id: string): Promise<PluginGroupOutput> {
	const group = await requireWorkbench(pCtx).pluginCatalog.getGroup(id)
	if (!group) {
		throw new GraphQLError('Plugin group not found', {
			extensions: { code: 'NOT_FOUND', id },
		})
	}
	return toOutput(group)
}

export async function writeGroups(
	pCtx: PlxContext,
	groups: PluginGroupInputValue[],
): Promise<PluginGroupOutput[]> {
	try {
		const result = await requireWorkbench(pCtx).pluginCatalog.updateGroups(groups)
		return result.map(toOutput)
	} catch (error) {
		if (error && typeof error === 'object' && 'code' in error) {
			throw new GraphQLError(error instanceof Error ? error.message : 'Invalid plugin groups', {
				extensions: { code: String(error.code) },
			})
		}
		throw error
	}
}

function toOutput(group: {
	groupId: string
	name: string
	pluginIds: readonly string[]
}): PluginGroupOutput {
	return {
		__typename: 'PluginGroup' as const,
		id: group.groupId,
		groupId: group.groupId,
		name: group.name,
		pluginIds: [...group.pluginIds],
	}
}
