import type { Context as PlxContext } from '@pluxel/core'
import { GraphQLError } from 'graphql'
import * as v from 'valibot'

import { PluginGroupInput, type PluginGroupInputValue, type PluginGroupOutput } from './schema'

export function readGroups(pCtx: PlxContext): PluginGroupOutput[] {
	const raw = pCtx.configService.getExtra('groups')
	if (!Array.isArray(raw)) return []
	return raw
		.filter((item): item is PluginGroupInputValue => v.safeParse(PluginGroupInput, item).success)
		.map((item) => ({
			__typename: 'PluginGroup' as const,
			id: item.groupId,
			groupId: item.groupId,
			name: item.name,
			pluginIds: item.pluginIds.map(String),
		})) satisfies PluginGroupOutput[]
}

export function readGroup(pCtx: PlxContext, id: string): PluginGroupOutput {
	const group = readGroups(pCtx).find((item) => item.id === id)
	if (!group) {
		throw new GraphQLError('Plugin group not found', {
			extensions: { code: 'NOT_FOUND', id },
		})
	}
	return group
}

export function writeGroups(
	pCtx: PlxContext,
	groups: PluginGroupInputValue[],
): PluginGroupOutput[] {
	pCtx.configService.setExtra(
		'groups',
		groups.map((group) => ({
			groupId: group.groupId,
			name: group.name,
			pluginIds: group.pluginIds,
		})),
	)
	return groups.map((group) => ({
		__typename: 'PluginGroup' as const,
		id: group.groupId,
		groupId: group.groupId,
		name: group.name,
		pluginIds: group.pluginIds,
	})) satisfies PluginGroupOutput[]
}
