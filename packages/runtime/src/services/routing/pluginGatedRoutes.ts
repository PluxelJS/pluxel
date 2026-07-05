import type { Context } from '@pluxel/core'
import { isPluginEnabled as isRuntimePluginEnabled } from '../RuntimeStateStore'

export type PluginId = string
export type RouteId = string

export interface PluginGatedRouteMeta {
	/**
	 * Auth/permission metadata.
	 *
	 * Keep this minimal and purely declarative; enforcement belongs to the backend layer.
	 */
	auth?: 'public' | 'authenticated' | 'admin' | { permissions: readonly string[] }
}

export interface PluginGatedDef {
	id: RouteId
	plugin: PluginId
	meta?: PluginGatedRouteMeta
}

export type IsPluginEnabled = (plugin: PluginId, ctx: Context) => boolean

export interface PluginGatedOptions {
	/**
	 * Resolve whether a plugin is enabled.
	 *
	 * Default: `ctx.runtimeState?.snapshot().enabled.includes(plugin) ?? true`
	 */
	isPluginEnabled?: IsPluginEnabled
}

export interface PluginRoutingSnapshot {
	enabledPlugins: PluginId[]
	enabledRouteIds: RouteId[]
}

function defaultIsPluginEnabled(plugin: PluginId, ctx: Context): boolean {
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
	const enabledPlugins = new Set<PluginId>()
	const enabledRouteIds: RouteId[] = []

	for (const route of routes) {
		if (!isPluginEnabled(route.plugin, ctx)) continue
		enabledPlugins.add(route.plugin)
		enabledRouteIds.push(route.id)
	}

	return {
		enabledPlugins: [...enabledPlugins].sort(),
		enabledRouteIds: enabledRouteIds.sort(),
	}
}
