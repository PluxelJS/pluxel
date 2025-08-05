import { Hono } from 'hono'
import type { AppEnv } from '../../services/hono/env'
import pluginsApp from './plugins'

const app = new Hono<AppEnv>()
	.get('/', (c) => {
		return c.text('Hello Hono!')
	})
	.route('/plugins', pluginsApp)

export default app

export type AppType = typeof app
