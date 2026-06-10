import { field, query, resolver, type Resolver } from '@gqloom/core'
import type { Context as PlxContext } from '@pluxel/core'
import * as v from 'valibot'

import { getStatusOverview } from '../pluginStatus/service'
import { PluginStatusOverview } from '../pluginStatus/schema'
import { Plugin, PluginCatalog, PluginDetail } from './schema'
import { createPlugin, getPluginDependencies, getPluginCtor, listPlugins } from './scope'

export function createPluginResolvers(pCtx: PlxContext): Resolver[] {
	const queries = resolver({
		pluginCatalog: query(PluginCatalog).resolve(() => ({ __typename: 'PluginCatalog' as const })),
		plugin: query(Plugin)
			.input({ id: v.string() })
			.resolve(({ id }) => createPlugin(pCtx, id)),
		plugins: query(v.array(Plugin)).resolve(() => listPlugins(pCtx)),
		pluginStatus: query(PluginStatusOverview).resolve(() => getStatusOverview(pCtx)),
	})

	const catalogFields = resolver.of(PluginCatalog, {
		plugin: field(Plugin)
			.input({ id: v.string() })
			.resolve((_catalog, { id }) => createPlugin(pCtx, id)),
		plugins: field(v.array(Plugin)).resolve(() => listPlugins(pCtx)),
		status: field(PluginStatusOverview).resolve(() => getStatusOverview(pCtx)),
	})

	const pluginFields = resolver.of(Plugin, {
		detail: field(PluginDetail).resolve((plugin) => {
			const ctor = getPluginCtor(pCtx, plugin)
			return {
				__typename: 'PluginDetail' as const,
				name: plugin.name,
				desc: '插件示例描述',
				dependencies: getPluginDependencies(pCtx, ctor),
			}
		}),
	})

	return [queries, catalogFields, pluginFields] satisfies Resolver[]
}
