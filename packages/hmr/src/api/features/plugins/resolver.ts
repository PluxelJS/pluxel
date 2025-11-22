import { field, query, resolver } from '@gqloom/core'
import type { Resolver } from '@gqloom/core'
import type { Context as PlxContext } from '@pluxel/core'
import * as v from 'valibot'

import { getStatusOverview } from '../pluginStatus/service'
import { PluginStatusOverview } from '../pluginStatus/schema'
import { PluginDetail, PluginIdScope, PluginScope } from './schema'
import { createPluginScope, ensurePlugin, getPluginDependencies, getScopeCtor } from './scope'

export function createPluginResolvers(pCtx: PlxContext): Resolver[] {
	const queries = resolver({
		pluginId: query(PluginIdScope)
			.input({ name: v.string() })
			.resolve(async ({ name }) => {
				ensurePlugin(pCtx, name)
				return { __typename: 'PluginIdScope', name }
			}),
		plugin: query(PluginScope)
			.input({ name: v.string() })
			.resolve(({ name }) => createPluginScope(pCtx, name)),
		pluginStatus: query(PluginStatusOverview).resolve(() => getStatusOverview(pCtx)),
	})

	const scopeFields = resolver.of(PluginScope, {
		detail: field(PluginDetail).resolve((scope) => {
			const ctor = getScopeCtor(pCtx, scope)
			return {
				__typename: 'PluginDetail' as const,
				name: scope.name,
				desc: '插件示例描述',
				dependencies: getPluginDependencies(pCtx, ctor),
			}
		}),
	}) as unknown as Resolver

	return [queries, scopeFields] satisfies Resolver[]
}
