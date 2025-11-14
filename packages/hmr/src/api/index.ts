import type { Resolver } from '@gqloom/core'
import type { Context as PlxContext } from '@pluxel/core'

import { createPluginGroupsModule } from './modules/groups'
import { createMarketModule } from './modules/market'
import { createPluginDetailModule, createPluginQueryModule } from './modules/pluginQueries'
import { createSnapshotModule } from './modules/snapshot'
import { createPluginStatusModule } from './modules/status'

export function getAPISchema(pCtx: PlxContext): Resolver[] {
	return [
		createPluginQueryModule(pCtx),
		createPluginDetailModule(pCtx),
		createPluginGroupsModule(pCtx),
		createMarketModule(pCtx),
		...createPluginStatusModule(pCtx),
		createSnapshotModule(pCtx),
	] satisfies Resolver[]
}
