import { field, resolver } from '@gqloom/core'
import type { Resolver } from '@gqloom/core'
import type { Context as PlxContext } from '@pluxel/core'

import { PluginScope } from '../plugins/schema'
import { getScopeCtor } from '../plugins/scope'
import { PluginStatusEntry } from './schema'
import { readStatusSnapshot } from './service'

export function createPluginStatusResolvers(pCtx: PlxContext): Resolver[] {
	const scopeStatus = resolver.of(PluginScope, {
		status: field(PluginStatusEntry).resolve((scope) => {
			const ctor = getScopeCtor(pCtx, scope)
			const { isRunning, isEnabled, lifecycleStage, source } = readStatusSnapshot(
				pCtx,
				scope.name,
				ctor,
			)
			return {
				__typename: 'PluginStatusEntry' as const,
				name: scope.name,
				isRunning,
				isEnabled,
				lifecycleStage,
				source,
			}
		}),
	}) as unknown as Resolver

	// updatePluginStatus mutation 已迁移到 RPC: PluginHandle.updateStatus()

	return [scopeStatus] satisfies Resolver[]
}
