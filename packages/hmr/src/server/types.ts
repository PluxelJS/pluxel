import type { Context } from 'hono'

import type { AppEnv } from '../services/hono/env'

export type RenderHandler = (ctx: Context<AppEnv>) => Response | Promise<Response>
