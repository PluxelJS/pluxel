import type { Context } from '@pluxel/core'
import type { Hono } from 'hono'

import type { DehydratedState, QueryClient } from '@tanstack/react-query'
import type { Env as HonoEnv } from 'hono'

export interface AppEnv extends HonoEnv {
	Variables: {
		plugin_ctx: Context
		qc: QueryClient
		dehydratedState: DehydratedState | undefined
	}
}
export type HonoType = Hono<AppEnv>
