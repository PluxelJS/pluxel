import type { Context as PlxContext } from '@pluxel/core'

import { createPluginGroupsModule } from './modules/groups'
import { createPluginDetailModule, createPluginQueryModule } from './modules/pluginQueries'
import { createSnapshotModule } from './modules/snapshot'
import { createPluginStatusModule } from './modules/status'

export function getAPISchema(pCtx: PlxContext) {
	return [
		createPluginQueryModule(pCtx),
		createPluginDetailModule(pCtx),
		createPluginGroupsModule(pCtx),
		...createPluginStatusModule(pCtx),
		createSnapshotModule(pCtx),
	]
}
