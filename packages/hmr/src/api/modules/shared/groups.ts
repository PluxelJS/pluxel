import type { Context as PlxContext } from '@pluxel/core'
import * as v from 'valibot'

import { PluginGroup, PluginGroupInput } from '../../schema'
import type { PluginGroupInputValue, PluginGroupOutput } from '../../schema'

export function readGroups(pCtx: PlxContext): PluginGroupOutput[] {
	const raw = pCtx.configService.getExtra('groups')
	if (!Array.isArray(raw)) return []
	return raw
		.filter((item): item is PluginGroupInputValue => v.safeParse(PluginGroupInput, item).success)
		.map((item) => ({
			__typename: 'PluginGroup' as const,
			groupId: item.groupId,
			name: item.name,
			pluginIds: item.pluginIds.map(String),
		})) satisfies PluginGroupOutput[]
}

export function writeGroups(pCtx: PlxContext, groups: PluginGroupInputValue[]): PluginGroupOutput[] {
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
		groupId: group.groupId,
		name: group.name,
		pluginIds: group.pluginIds,
	})) satisfies PluginGroupOutput[]
}
