import { field, mutation, resolver } from '@gqloom/core'
import type { Context as PlxContext } from '@pluxel/core'
import type { InferOutput } from 'valibot'

import {
	PluginScope,
	PluginStatusEntry,
	PluginStatusMutationResult,
	UpdateStatusInput,
} from '../schema'
import { createPluginScope, getScopeCtor } from './shared/pluginScope'

type Status = InferOutput<typeof UpdateStatusInput>['status']

const statusOps: Record<Status, Array<'enable' | 'disable'>> = {
	start: ['enable'],
	stop: ['disable'],
	restart: ['disable', 'enable'],
}

export function createPluginStatusModule(pCtx: PlxContext) {
	const scopeStatus = resolver.of(PluginScope, {
		status: field(PluginStatusEntry).resolve((scope) => ({
			__typename: 'PluginStatusEntry' as const,
			name: scope.name,
			isRunning: pCtx.loader.isRunning(getScopeCtor(pCtx, scope)),
		})),
	})

	const mutations = resolver({
		updatePluginStatus: mutation(PluginStatusMutationResult)
			.input(UpdateStatusInput)
			.resolve(async ({ name, status }) => {
				const scope = createPluginScope(pCtx, name)
				const ctor = getScopeCtor(pCtx, scope)
				const ops = statusOps[status]
				if (!ops) {
					return {
						__typename: 'PluginStatusMutationResult' as const,
						code: 'invalid_status',
						isRunning: null,
						error: `Unsupported status: ${status}`,
					}
				}

				try {
					const loaderRegistry = pCtx.loader.registry
					for (const action of ops) {
						if (action === 'enable') loaderRegistry.enable(name, ctor)
						else loaderRegistry.deactivate(name, ctor, { runtimeOnly: false })
					}
					const result = await pCtx.registry.commit()
					if (result.err) {
						return {
							__typename: 'PluginStatusMutationResult' as const,
							code: 'commit_failed',
							isRunning: pCtx.loader.isRunning(ctor),
							error: String(result.err),
						}
					}
					return {
						__typename: 'PluginStatusMutationResult' as const,
						code: 'success',
						isRunning: pCtx.loader.isRunning(ctor),
						error: null,
					}
				} catch (error) {
					const isStart = status === 'start' || status === 'restart'
					return {
						__typename: 'PluginStatusMutationResult' as const,
						code: isStart ? 'plugin_start_failed' : 'plugin_operation_failed',
						isRunning: pCtx.loader.isRunning(ctor),
						error: (error as Error)?.message ?? 'Unknown error',
					}
				}
			}),
	})

	return [scopeStatus, mutations]
}
