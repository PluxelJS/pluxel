import { field, query, resolver, type Resolver } from '@gqloom/core'
import { parsePluginNodeAddress, type Context as PlxContext } from '@pluxel/core'
import * as v from 'valibot'

import { getStatusOverview } from '../pluginStatus/service'
import { PluginStatusOverview } from '../pluginStatus/schema'
import { Plugin, PluginCatalog, PluginDetail } from './schema'
import { createPlugin, getPluginDependencies, listPlugins } from './scope'

export function createPluginResolvers(pCtx: PlxContext): Resolver[] {
	const queries = resolver({
		pluginCatalog: query(PluginCatalog).resolve(() => ({ __typename: 'PluginCatalog' as const })),
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
			return {
				__typename: 'PluginDetail' as const,
				name: plugin.name,
				desc: '插件示例描述',
				dependencies: getPluginDependencies(pCtx, parsePluginNodeAddress(plugin.address)),
			}
		}),
	})

	return [queries, catalogFields, pluginFields] satisfies Resolver[]
}
