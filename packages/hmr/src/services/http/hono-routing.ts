import type { Context } from '@pluxel/core'
import { Hono, type Handler } from 'hono'

import {
	resolveIsPluginEnabled,
	type PluginGatedOptions,
	type PluginGatedRouteDef,
} from '../routing/pluginGatedRoutes'
import type { AppEnv } from './hono-env'

function normalizePath(input: string): string {
	const raw = input.trim()
	if (!raw || raw === '/') return '/'
	return raw.startsWith('/') ? raw : `/${raw}`
}

export function createPluginGatedRouter(
	ctx: Context,
	routes: readonly PluginGatedRouteDef<Handler<AppEnv>>[],
	options: PluginGatedOptions = {},
) {
	const isPluginEnabled = resolveIsPluginEnabled(options)
	const router = new Hono<AppEnv>()

	for (const route of routes) {
		const method = route.method === 'ALL' ? '*' : route.method
		const path = normalizePath(route.path)
		const handler = route.handler(ctx)

		router.on(
			method as any,
			path,
			async (c, next) => {
				if (!isPluginEnabled(route.plugin, ctx)) return c.notFound()
				return next()
			},
			handler as any,
		)
	}

	return router
}

export type PluginGatedRoute = PluginGatedRouteDef<Handler<AppEnv>>
