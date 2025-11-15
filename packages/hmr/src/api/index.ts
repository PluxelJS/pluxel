import type { Resolver } from '@gqloom/core'
import type { Context as PlxContext } from '@pluxel/core'

import { createPluginGroupsResolver } from './features/groups'
import { createMarketResolver } from './features/market'
import { createPluginResolvers } from './features/plugins'
import { createPluginStatusResolvers } from './features/pluginStatus'
import { createSnapshotResolver } from './features/snapshot'

export function getAPISchema(pCtx: PlxContext): Resolver[] {
	return [
		...createPluginResolvers(pCtx),
		createPluginGroupsResolver(pCtx),
		createMarketResolver(pCtx),
		createSnapshotResolver(pCtx),
		...createPluginStatusResolvers(pCtx),
	] satisfies Resolver[]
}
