import { hc } from 'hono/client'
import type { AppType } from '../../hmr/src/services/hono/api'

export const client = hc<AppType>('http://localhost:3000/api')
