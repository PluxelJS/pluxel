import { field, resolver, type Resolver } from '@gqloom/core'
import { parsePluginNodeAddress, type Context as PlxContext } from '@pluxel/core'

import { Plugin } from '../plugins/schema'
import { PluginStatus } from './schema'
import { readStatusSnapshot } from './service'

export function createPluginStatusResolvers(pCtx: PlxContext): Resolver[] {
	const pluginStatus = resolver.of(Plugin, {
		status: field(PluginStatus).resolve((plugin) => {
			const { isRunning, isEnabled, lifecycleStage, availability, issues, source } =
				readStatusSnapshot(pCtx, parsePluginNodeAddress(plugin.address))
			return {
				__typename: 'PluginStatus' as const,
				isRunning,
				isEnabled,
				lifecycleStage,
				availability,
				issues: issues.map(({ id, code, message }) => ({
					__typename: 'PluginStatusIssue' as const,
					id,
					code,
					message,
				})),
				source,
			}
		}),
	})

	// Status mutations use the runtime RPC/command control plane.

	return [pluginStatus] satisfies Resolver[]
}
