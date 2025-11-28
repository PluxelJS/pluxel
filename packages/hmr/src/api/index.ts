import type { Resolver } from '@gqloom/core'
import type { Context as PlxContext } from '@pluxel/core'

import { createPluginGroupsResolver } from './features/groups'
import { createMarketResolver } from './features/market'
import { createPluginResolvers } from './features/plugins'
import { createPluginStatusResolvers } from './features/pluginStatus'

export function getAPISchema(pCtx: PlxContext): Resolver[] {
	return [
		...createPluginResolvers(pCtx),
		createPluginGroupsResolver(pCtx),
		createMarketResolver(pCtx),
		// buildSnapshot mutation 已迁移到 RPC
		...createPluginStatusResolvers(pCtx),
	] satisfies Resolver[]
}
