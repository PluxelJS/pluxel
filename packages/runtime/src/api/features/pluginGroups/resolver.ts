import { field, mutation, resolver } from '@gqloom/core'
import type { Context as PlxContext } from '@pluxel/core'
import * as v from 'valibot'

import { PluginCatalog } from '../plugins/schema'
import { PluginGroup, PluginGroupInput } from './schema'
import { readGroup, readGroups, writeGroups } from './service'

export function createPluginGroupsResolver(pCtx: PlxContext) {
	const rootFields = resolver({
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

	return [rootFields, catalogFields]
}
