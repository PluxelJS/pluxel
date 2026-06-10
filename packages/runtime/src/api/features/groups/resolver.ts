import { field, mutation, query, resolver } from '@gqloom/core'
import type { Context as PlxContext } from '@pluxel/core'
import * as v from 'valibot'

import { PluginCatalog } from '../plugins/schema'
import { PluginGroup, PluginGroupInput } from './schema'
import { readGroup, readGroups, writeGroups } from './service'

export function createPluginGroupsResolver(pCtx: PlxContext) {
	const queries = resolver({
		pluginGroup: query(PluginGroup)
			.input({ id: v.string() })
			.resolve(({ id }) => readGroup(pCtx, id)),
		pluginGroups: query(v.array(PluginGroup)).resolve(() => readGroups(pCtx)),
		updatePluginGroups: mutation(v.array(PluginGroup))
			.input({ groups: v.array(PluginGroupInput) })
			.resolve(({ groups }) => writeGroups(pCtx, groups)),
	})

	const catalogFields = resolver.of(PluginCatalog, {
		group: field(PluginGroup)
			.input({ id: v.string() })
			.resolve((_catalog, { id }) => readGroup(pCtx, id)),
		groups: field(v.array(PluginGroup)).resolve(() => readGroups(pCtx)),
	})

	return [queries, catalogFields]
}
