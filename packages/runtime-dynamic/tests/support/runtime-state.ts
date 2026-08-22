import {
	pluginNodeAddressOf,
	type Context,
	type PluginConstructor,
	type PluginNodeAddress,
} from '@pluxel/core'
import {
	isPluginEnabled,
	requireRuntimePluginGraphCoordinator,
	requireRuntimeStateStore,
	runtimeStatePatch,
	type RuntimeStatePatch,
} from '@pluxel/runtime/internal'

type PluginTarget = PluginConstructor | PluginNodeAddress

function addressOf(target: PluginTarget): PluginNodeAddress {
	return typeof target === 'function' ? pluginNodeAddressOf(target) : target
}

export async function enablePlugins(ctx: Context, ...targets: PluginTarget[]): Promise<void> {
	await requireRuntimePluginGraphCoordinator(ctx).updateRuntimeState(
		enablePluginsPatch(...targets),
		'test-enable-plugins',
	)
}

/** Desired-state patch for a catalog batch that publishes these nodes atomically. */
export function enablePluginsPatch(...targets: PluginTarget[]): RuntimeStatePatch {
	return runtimeStatePatch(
		...targets.map((target) => ({
			type: 'set-enabled' as const,
			node: addressOf(target),
			enabled: true,
		})),
	)
}

export async function disablePlugins(ctx: Context, ...targets: PluginTarget[]): Promise<void> {
	await requireRuntimePluginGraphCoordinator(ctx).updateRuntimeState(
		runtimeStatePatch(
			...targets.map((target) => ({
				type: 'set-enabled' as const,
				node: addressOf(target),
				enabled: false,
			})),
		),
		'test-disable-plugins',
	)
}

export function isEnabled(ctx: Context, target: PluginTarget): boolean {
	return isPluginEnabled(requireRuntimeStateStore(ctx).snapshot(), addressOf(target))
}
