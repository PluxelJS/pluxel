import { field, mutation, resolver } from '@gqloom/core'
import type { Context as PlxContext, PluginConstructor } from '@pluxel/core'
import type { InferOutput } from 'valibot'

import {
	PluginScope,
	PluginStatusEntry,
	PluginStatusMutationResult,
	UpdateStatusInput,
	type PluginStatusEntryLifecycleStage,
} from '../schema'
import { createPluginScope, getScopeCtor } from './shared/pluginScope'

type Status = InferOutput<typeof UpdateStatusInput>['status']

type Snapshot = {
	isRunning: boolean
	isEnabled: boolean
	lifecycleStage: InferOutput<typeof PluginStatusEntryLifecycleStage>
}

function readStatusSnapshot(pCtx: PlxContext, name: string, ctor: PluginConstructor): Snapshot {
	const isRunning = pCtx.loader.isRunning(ctor)
	const isEnabled = pCtx.configService.isEnable(name)
	const lifecycleStage = !isEnabled ? 'disabled' : isRunning ? 'running' : 'stopped'
	return { isRunning, isEnabled, lifecycleStage }
}

export function createPluginStatusModule(pCtx: PlxContext) {
	const scopeStatus = resolver.of(PluginScope, {
		status: field(PluginStatusEntry).resolve((scope) => {
			const ctor = getScopeCtor(pCtx, scope)
			const { isRunning, isEnabled, lifecycleStage } = readStatusSnapshot(pCtx, scope.name, ctor)
			return {
				__typename: 'PluginStatusEntry' as const,
				name: scope.name,
				isRunning,
				isEnabled,
				lifecycleStage,
			}
		}),
	})

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

	return [scopeStatus, mutations]
}
