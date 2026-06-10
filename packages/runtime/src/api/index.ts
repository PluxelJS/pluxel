import type { Resolver } from '@gqloom/core'
import type { Context as PlxContext } from '@pluxel/core'

import { getRuntimeApiResolvers } from './contributions'
import { createPluginGroupsResolver } from './features/groups/resolver'
import { createPluginResolvers } from './features/plugins/resolver'
import { createPluginStatusResolvers } from './features/pluginStatus/resolver'

export function getAPISchema(pCtx: PlxContext): Resolver[] {
	return [
		...createPluginResolvers(pCtx),
		...createPluginGroupsResolver(pCtx),
		// buildSnapshot mutation 已迁移到 RPC
		...createPluginStatusResolvers(pCtx),
		...getRuntimeApiResolvers(pCtx),
	] satisfies Resolver[]
}
