import type { Context } from '@pluxel/core'
import { Hono } from 'hono'

import type { AppEnv, HonoWithAppEnvType } from './hono-env'

export function attachPluginContext(
	ctx: Context,
	app: Pick<Hono<AppEnv>, 'use'>,
): void {
	app.use(async (c, next) => {
		c.set('plugin_ctx', ctx)
		await next()
	})
}

export function createHonoApp(
	ctx: Context,
	app: Hono<AppEnv> = new Hono<AppEnv>({}),
): HonoWithAppEnvType {
	attachPluginContext(ctx, app)
	return app as HonoWithAppEnvType
}
