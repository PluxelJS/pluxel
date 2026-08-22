import { pluginNodeIndexKey, type Context, type PluginNodeAddress } from '@pluxel/core'
import { isPluginEnabled as isRuntimePluginEnabled } from '../RuntimeStateStore'
import { requireRuntimeStateStore } from '../../internal/runtime-state'

export type PluginOwner = PluginNodeAddress
export type RouteId = string

export interface PluginGatedDef {
	id: RouteId
	plugin: PluginOwner
}

export type IsPluginEnabled = (plugin: PluginOwner, ctx: Context) => boolean

export interface PluginGatedOptions {
	/**
	 * Resolve whether a plugin is enabled.
	 *
	 * Default: the host RuntimeState snapshot.
	 */
	isPluginEnabled?: IsPluginEnabled
}

export interface PluginRoutingSnapshot {
	enabledPlugins: PluginOwner[]
	enabledRouteIds: RouteId[]
}

function defaultIsPluginEnabled(plugin: PluginOwner, ctx: Context): boolean {
	return isRuntimePluginEnabled(requireRuntimeStateStore(ctx).snapshot(), plugin)
}

export function resolveIsPluginEnabled(options: PluginGatedOptions | undefined): IsPluginEnabled {
	return options?.isPluginEnabled ?? defaultIsPluginEnabled
}

export function getPluginRoutingSnapshot<T extends PluginGatedDef>(
	ctx: Context,
	routes: readonly T[],
	options: PluginGatedOptions = {},
): PluginRoutingSnapshot {
	const isPluginEnabled = resolveIsPluginEnabled(options)
	const enabledPlugins = new Map<string, PluginOwner>()
	const enabledRouteIds: RouteId[] = []

	for (const route of routes) {
		if (!isPluginEnabled(route.plugin, ctx)) continue
		enabledPlugins.set(pluginNodeIndexKey(route.plugin), route.plugin)
		enabledRouteIds.push(route.id)
	}

	return {
		enabledPlugins: [...enabledPlugins.values()],
		enabledRouteIds: enabledRouteIds.sort(),
	}
}
