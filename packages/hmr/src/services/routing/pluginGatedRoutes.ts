import type { Context } from '@pluxel/core'

export type PluginId = string
export type RouteId = string
export type HttpMethod =
	| 'GET'
	| 'POST'
	| 'PUT'
	| 'PATCH'
	| 'DELETE'
	| 'OPTIONS'
	| 'HEAD'
	| 'ALL'

export interface PluginGatedRouteMeta {
	/**
	 * Auth/permission metadata.
	 *
	 * Keep this minimal and purely declarative; enforcement belongs to the backend layer.
	 */
	auth?: 'public' | 'authenticated' | 'admin' | { permissions: readonly string[] }
}

export type RouteHandlerFactory<H> = (ctx: Context) => H

/**
 * Router-agnostic route definition.
 *
 * Adapter layers (Hono / Fastify / Express / etc.) decide how to mount `handler`.
 */
export interface PluginGatedRouteDef<H> {
	id: RouteId
	plugin: PluginId
	method: HttpMethod
	/** Path relative to the mount base (e.g. `/users/:id`). */
	path: string
	handler: RouteHandlerFactory<H>
	meta?: PluginGatedRouteMeta
}

export type IsPluginEnabled = (plugin: PluginId, ctx: Context) => boolean

export interface PluginGatedOptions {
	/**
	 * Resolve whether a plugin is enabled.
	 *
	 * Default: `ctx.configService?.isEnabledInConfig(plugin) ?? true`
	 */
	isPluginEnabled?: IsPluginEnabled
}

export interface PluginRoutingSnapshot {
	enabledPlugins: PluginId[]
	enabledRouteIds: RouteId[]
}

function defaultIsPluginEnabled(plugin: PluginId, ctx: Context): boolean {
	const svc = (ctx as unknown as { configService?: unknown }).configService as
		| { isEnabledInConfig?: (name: string) => boolean }
		| undefined
	const fn = svc?.isEnabledInConfig
	return typeof fn === 'function' ? Boolean(fn.call(svc, plugin)) : true
}

export function resolveIsPluginEnabled(options: PluginGatedOptions | undefined): IsPluginEnabled {
	return options?.isPluginEnabled ?? defaultIsPluginEnabled
}

export function getPluginRoutingSnapshot<H>(
	ctx: Context,
	routes: readonly PluginGatedRouteDef<H>[],
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
		enabledPlugins: Array.from(enabledPlugins).sort(),
		enabledRouteIds: enabledRouteIds.sort(),
	}
}
