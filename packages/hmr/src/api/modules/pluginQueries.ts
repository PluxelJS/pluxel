import { field, query, resolver } from '@gqloom/core'
import type { Context as PlxContext } from '@pluxel/core'
import * as v from 'valibot'

import { PluginDetail, PluginIdScope, PluginScope, PluginStatusOverview } from '../schema'
import {
	createPluginScope,
	ensurePlugin,
	getPluginDependencies,
	getScopeCtor,
} from './shared/pluginScope'
import { getStatusOverview } from './shared/status'

export function createPluginQueryModule(pCtx: PlxContext) {
	return resolver({
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
}

export function createPluginDetailModule(pCtx: PlxContext) {
	return resolver.of(PluginScope, {
		detail: field(PluginDetail).resolve((scope) => {
			const ctor = getScopeCtor(pCtx, scope)
			return {
				__typename: 'PluginDetail' as const,
				name: scope.name,
				desc: '插件示例描述',
				dependencies: getPluginDependencies(pCtx, ctor),
			}
		}),
	})
}
