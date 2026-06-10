import { field, resolver, type Resolver } from '@gqloom/core'
import type { Context as PlxContext } from '@pluxel/core'

import { Plugin } from '../plugins/schema'
import { getPluginCtor } from '../plugins/scope'
import { PluginStatus } from './schema'
import { readStatusSnapshot } from './service'

export function createPluginStatusResolvers(pCtx: PlxContext): Resolver[] {
	const pluginStatus = resolver.of(Plugin, {
		status: field(PluginStatus).resolve((plugin) => {
			const ctor = getPluginCtor(pCtx, plugin)
			const { isRunning, isEnabled, lifecycleStage, source } = readStatusSnapshot(
				pCtx,
				plugin.name,
				ctor,
			)
			return {
				__typename: 'PluginStatus' as const,
				isRunning,
				isEnabled,
				lifecycleStage,
				source,
			}
		}),
	})

	// updatePluginStatus mutation 已迁移到 runtime op: plugin.start|stop|restart|enable|disable

	return [pluginStatus] satisfies Resolver[]
}
