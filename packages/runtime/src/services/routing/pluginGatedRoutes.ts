import type { Context, PluginNodeAddressSnapshot } from '@pluxel/core'
import { isPluginEnabled as isRuntimePluginEnabled } from '../RuntimeStateStore'
import { pluginNodeAddressKey } from '../../runtime/plugin-address'

export type PluginOwner = PluginNodeAddressSnapshot
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
	 * Default: `ctx.runtimeState?.snapshot().enabled.includes(plugin) ?? true`
	 */
	isPluginEnabled?: IsPluginEnabled
}

export interface PluginRoutingSnapshot {
	enabledPlugins: PluginOwner[]
	enabledRouteIds: RouteId[]
}

function defaultIsPluginEnabled(plugin: PluginOwner, ctx: Context): boolean {
	const runtimeState = (ctx as unknown as { runtimeState?: unknown }).runtimeState as
		| { snapshot?: () => Parameters<typeof isRuntimePluginEnabled>[0] }
		| undefined
	const snapshot = runtimeState?.snapshot
	return typeof snapshot === 'function'
		? isRuntimePluginEnabled(snapshot.call(runtimeState), plugin)
		: true
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
		enabledPlugins.set(pluginNodeAddressKey(route.plugin), route.plugin)
		enabledRouteIds.push(route.id)
	}

	return {
		enabledPlugins: [...enabledPlugins.values()],
		enabledRouteIds: enabledRouteIds.sort(),
	}
}
