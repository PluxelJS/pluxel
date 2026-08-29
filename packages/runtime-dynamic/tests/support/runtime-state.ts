import {
	pluginNodeAddressOf,
	type Context,
	type PluginConstructor,
	type PluginNodeAddress,
} from '@pluxel/core'
import {
	isPluginAutoStartEnabled,
	requireRuntimePluginGraphCoordinator,
	requireRuntimeStateStore,
	runtimeStatePatch,
	type RuntimeStatePatch,
} from '@pluxel/runtime/internal'

type PluginTarget = PluginConstructor | PluginNodeAddress

function addressOf(target: PluginTarget): PluginNodeAddress {
	return typeof target === 'function' ? pluginNodeAddressOf(target) : target
}

export async function setPluginsAutoStart(
	ctx: Context,
	autoStart: boolean,
	...targets: PluginTarget[]
): Promise<void> {
	await requireRuntimePluginGraphCoordinator(ctx).updateRuntimeState(
		pluginsAutoStartPatch(autoStart, ...targets),
		'test-set-plugins-auto-start',
	)
}

export async function startPlugins(ctx: Context, ...targets: PluginTarget[]): Promise<void> {
	const coordinator = requireRuntimePluginGraphCoordinator(ctx)
	for (const target of targets) await coordinator.startNode(addressOf(target), 'test-start-plugin')
}

/** Desired-state patch for a catalog batch that publishes these nodes atomically. */
export function pluginsAutoStartPatch(
	autoStart: boolean,
	...targets: PluginTarget[]
): RuntimeStatePatch {
	return runtimeStatePatch(
		...targets.map((target) => ({
			type: 'set-auto-start' as const,
			node: addressOf(target),
			autoStart,
		})),
	)
}

export function isAutoStartEnabled(ctx: Context, target: PluginTarget): boolean {
	return isPluginAutoStartEnabled(requireRuntimeStateStore(ctx).snapshot(), addressOf(target))
}
