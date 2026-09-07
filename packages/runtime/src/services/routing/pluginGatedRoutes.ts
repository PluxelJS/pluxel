import { pluginNodeIndexKey, type Context, type PluginNodeAddress } from '@pluxel/core'
import { requirePluginService } from '@pluxel/core/internal'

export type PluginOwner = PluginNodeAddress
export type RouteId = string

export interface PluginGatedDef {
	id: RouteId
	plugin: PluginOwner
}

export type IsPluginRunning = (plugin: PluginOwner, ctx: Context) => boolean

export interface PluginGatedOptions {
	/**
	 * Resolve whether a Plugin generation is currently running.
	 *
	 * Default: the committed Core lifecycle projection.
	 */
	isPluginRunning?: IsPluginRunning
}

export interface PluginRoutingSnapshot {
	runningPlugins: PluginOwner[]
	runningRouteIds: RouteId[]
}

function defaultIsPluginRunning(plugin: PluginOwner, ctx: Context): boolean {
	return requirePluginService(ctx).isRunning(plugin)
}

export function resolveIsPluginRunning(options: PluginGatedOptions | undefined): IsPluginRunning {
	return options?.isPluginRunning ?? defaultIsPluginRunning
}

export function getPluginRoutingSnapshot<T extends PluginGatedDef>(
	ctx: Context,
	routes: readonly T[],
	options: PluginGatedOptions = {},
): PluginRoutingSnapshot {
	const isPluginRunning = resolveIsPluginRunning(options)
	const runningPlugins = new Map<string, PluginOwner>()
	const runningRouteIds: RouteId[] = []

	for (const route of routes) {
		if (!isPluginRunning(route.plugin, ctx)) continue
		runningPlugins.set(pluginNodeIndexKey(route.plugin), route.plugin)
		runningRouteIds.push(route.id)
	}

	return {
		runningPlugins: [...runningPlugins.values()],
		runningRouteIds: runningRouteIds.sort(),
	}
}
