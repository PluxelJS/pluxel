import { field, mutation, resolver } from '@gqloom/core'
import type { Resolver } from '@gqloom/core'
import type { Context as PlxContext } from '@pluxel/core'

import { PluginScope } from '../plugins/schema'
import { createPluginScope, getScopeCtor } from '../plugins/scope'
import {
	PluginStatusEntry,
	PluginStatusMutationResult,
	UpdateStatusInput,
} from './schema'
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

	const mutations = resolver({
		updatePluginStatus: mutation(PluginStatusMutationResult)
			.input(UpdateStatusInput)
			.resolve(async ({ name, status }) => {
				const scope = createPluginScope(pCtx, name)
				const ctor = getScopeCtor(pCtx, scope)
				const loaderRegistry = pCtx.loader.registry

				const invalid = () => ({
					__typename: 'PluginStatusMutationResult' as const,
					code: 'invalid_status',
					isRunning: null,
					isEnabled: null,
					lifecycleStage: null,
					error: `Unsupported status: ${status}`,
				})

				try {
					switch (status) {
						case 'start':
							loaderRegistry.enable(name, ctor)
							break
						case 'stop':
							loaderRegistry.deactivate(name, ctor, { runtimeOnly: true })
							break
						case 'restart':
							loaderRegistry.deactivate(name, ctor, { runtimeOnly: true })
							loaderRegistry.enable(name, ctor)
							break
						case 'disable':
							loaderRegistry.deactivate(name, ctor, { runtimeOnly: false })
							break
						case 'enable':
							loaderRegistry.enablePersisted(name)
							break
						default:
							return invalid()
					}

					const result = await pCtx.registry.commit()
					if (result.err) {
						const { isRunning, isEnabled, lifecycleStage } = readStatusSnapshot(pCtx, name, ctor)
						return {
							__typename: 'PluginStatusMutationResult' as const,
							code: 'commit_failed',
							isRunning,
							isEnabled,
							lifecycleStage,
							error: String(result.err),
						}
					}

					const { isRunning, isEnabled, lifecycleStage } = readStatusSnapshot(pCtx, name, ctor)
					return {
						__typename: 'PluginStatusMutationResult' as const,
						code: 'success',
						isRunning,
						isEnabled,
						lifecycleStage,
						error: null,
					}
				} catch (error) {
					const isStart = status === 'start' || status === 'restart'
					const { isRunning, isEnabled, lifecycleStage } = readStatusSnapshot(pCtx, name, ctor)
					return {
						__typename: 'PluginStatusMutationResult' as const,
						code: isStart ? 'plugin_start_failed' : 'plugin_operation_failed',
						isRunning,
						isEnabled,
						lifecycleStage,
						error: (error as Error)?.message ?? 'Unknown error',
					}
				}
			}),
	})

	return [scopeStatus, mutations] satisfies Resolver[]
}
