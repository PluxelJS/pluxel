import type { Context } from '@pluxel/core'
import type { Hono } from 'hono'

export type Env = {
	Variables: {
		plugin_ctx: Context
	}
}
export type HonoType = Hono<Env>
