import type { Context } from '@pluxel/core'
import type { Hono, Env as HonoEnv } from 'hono'

export type AppEnv = HonoEnv & {
	Variables: {
		plugin_ctx: Context
	}
}
export type HonoWithAppEnvType = Hono<AppEnv>
