import type { Context } from 'hono'

import type { AppEnv } from '../services/http/hono-env'

export type RenderHandler = (ctx: Context<AppEnv>) => Response | Promise<Response>
