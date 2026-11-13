import {
	parsePluginNodeAddress,
	pluginDefinitionIndexKey,
	type RootContext,
	type PluginNodeAddress,
} from '@pluxel/core'
import { requirePluginService } from '@pluxel/core/internal'
import { requirePluginHostCoordinator } from '@pluxel/host/internal'
import { ScriptExecutionError, type ScriptScope } from '@pluxel/host/agent'
import type { ProjectSdk, ProjectPluginTarget, ProjectPluginInstance } from './project'

/** The extension borrows the same run scope and Host as the portable SDK. */
export function createProjectSdk(ctx: RootContext, scope: ScriptScope): ProjectSdk {
	const coordinator = requirePluginHostCoordinator(ctx)
	const address = (target: ProjectPluginTarget): PluginNodeAddress => {
		scope.assertOpen()
		if (
			typeof target !== 'function' &&
			(!target || typeof target !== 'object' || !('plugin' in target))
		)
			throw new TypeError('dev.address and dev.instance require a Plugin constructor or typed fork')
		const implementation = typeof target === 'function' ? target : target.plugin
		const node =
			typeof target === 'function'
				? target.nodeAddress()
				: parsePluginNodeAddress({
						definition: implementation.nodeAddress().definition,
						variant: 'fork',
						forkId: target.forkId,
					})
		const current = coordinator
			.catalogSnapshot()
			.byDefinition.get(pluginDefinitionIndexKey(node.definition))
		if (!current)
			throw new ScriptExecutionError(
				'target_unavailable',
				'Plugin definition is absent from the current catalog',
			)
		if (current.candidate.implementation !== implementation)
			throw new ScriptExecutionError(
				'stale_target',
				'Plugin constructor was replaced; import the current implementation',
			)
		return node
	}
	return Object.freeze({
		...scope.sdk,
		dev: Object.freeze({
			get ctx() {
				scope.assertOpen()
				return ctx
			},
			address,
			instance: <T extends ProjectPluginTarget>(target: T): ProjectPluginInstance<T> => {
				const instance = requirePluginService(ctx).getInstance(address(target))
				if (!instance)
					throw new ScriptExecutionError('plugin_not_running', 'Plugin node is not running')
				return instance as ProjectPluginInstance<T>
			},
		}),
	})
}
