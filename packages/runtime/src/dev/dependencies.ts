import {
	parsePluginDefinitionAddress,
	pluginDefinitionAddressOf,
	pluginDefinitionIndexKey,
	type PluginNodeAddress,
	type RootContext,
} from '@pluxel/core'
import {
	inspectPluginConsumerRequirements,
	PluginNodeUnavailableError,
	setPluginConsumerOverride,
	setPluginProviderDefault,
} from '../api/usecases/pluginDependencies'
import { requireRuntimePluginGraphCoordinator } from '../internal/reconciliation'
import {
	DevConsoleError,
	type DevConsole,
	type DevPluginRequirement,
	type DevPluginTarget,
} from './contracts'
import type { DevScope } from './scope'

export function createDevDependencies(
	ctx: RootContext,
	scope: DevScope,
	resolveTarget: (target: DevPluginTarget) => PluginNodeAddress,
): DevConsole['dependencies'] {
	const resolveRequirement = (requirement: DevPluginRequirement) => {
		scope.assertOpen()
		if (typeof requirement !== 'function') return parsePluginDefinitionAddress(requirement)
		const address = pluginDefinitionAddressOf(requirement)
		const key = pluginDefinitionIndexKey(address)
		const catalog = requireRuntimePluginGraphCoordinator(ctx).catalogSnapshot()
		const concrete = catalog.byDefinition.get(key)
		if (concrete) {
			if (concrete.candidate.implementation !== requirement) {
				throw new DevConsoleError(
					'stale_target',
					'Plugin requirement constructor was replaced; import the current implementation',
				)
			}
			return address
		}
		// Abstract tokens carry stable definition identity, not a concrete generation identity.
		if (
			catalog.entries.some(
				({ candidate: { declaration } }) =>
					(declaration.provides && pluginDefinitionIndexKey(declaration.provides) === key) ||
					declaration.requires.some((item) => pluginDefinitionIndexKey(item) === key),
			)
		)
			return address
		throw new DevConsoleError(
			'target_unavailable',
			'Plugin requirement is absent from the current catalog',
		)
	}
	return Object.freeze({
		inspect: (consumer) =>
			scope.run(() => {
				try {
					return {
						ok: true,
						items: inspectPluginConsumerRequirements(ctx, resolveTarget(consumer)),
					}
				} catch (error) {
					if (error instanceof PluginNodeUnavailableError) {
						return {
							ok: false,
							code: 'consumer_unavailable',
							state: 'unchanged',
							error: error.message,
						}
					}
					throw error
				}
			}),
		setDefault: (input) =>
			scope.run(() =>
				setPluginProviderDefault(
					ctx,
					resolveRequirement(input.requirement),
					resolveTarget(input.provider),
				),
			),
		clearDefault: (requirement) =>
			scope.run(() => setPluginProviderDefault(ctx, resolveRequirement(requirement), null)),
		setOverride: (input) =>
			scope.run(() =>
				setPluginConsumerOverride(
					ctx,
					resolveTarget(input.consumer),
					resolveRequirement(input.requirement),
					resolveTarget(input.provider),
				),
			),
		clearOverride: (input) =>
			scope.run(() =>
				setPluginConsumerOverride(
					ctx,
					resolveTarget(input.consumer),
					resolveRequirement(input.requirement),
					null,
				),
			),
	} satisfies DevConsole['dependencies'])
}
