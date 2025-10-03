import { mutation, query, resolver } from '@gqloom/core'
import type { Context as PlxContext } from '@pluxel/core'
import * as v from 'valibot'

import { PluginGroup, PluginGroupInput } from '../schema'
import { readGroups, writeGroups } from './shared/groups'

export function createPluginGroupsModule(pCtx: PlxContext) {
	return resolver({
		pluginGroups: query(v.array(PluginGroup)).resolve(() => readGroups(pCtx)),
		updatePluginGroups: mutation(v.array(PluginGroup))
			.input({ groups: v.array(PluginGroupInput) })
			.resolve(({ groups }) => writeGroups(pCtx, groups)),
	})
}
