import type { Context } from '@pluxel/core'
import type { DehydratedState, QueryClient } from '@tanstack/react-query'
import type { Hono, Env as HonoEnv } from 'hono'

export type AppEnv = HonoEnv & {
	Variables: {
		plugin_ctx: Context
		qc: QueryClient
		dehydratedState: DehydratedState | undefined
	}
}
export type HonoType = Hono<AppEnv>
