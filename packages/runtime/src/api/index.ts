import type { Resolver } from '@gqloom/core'
import type { Context as PlxContext } from '@pluxel/core'

import { createPluginGroupsResolver } from './features/pluginGroups/resolver'
import { createPluginResolvers } from './features/plugins/resolver'
import { createPluginStatusResolvers } from './features/pluginStatus/resolver'

export function getAPISchema(pCtx: PlxContext): Resolver[] {
	return [
		...createPluginResolvers(pCtx),
		...createPluginGroupsResolver(pCtx),
		...createPluginStatusResolvers(pCtx),
	] satisfies Resolver[]
}
