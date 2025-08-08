import { hc } from 'hono/client'
import type { AppType } from './api'
export type * from 'hono/client'

export const client = hc<AppType>('http://localhost:3000/api')
