import { writeFile } from 'node:fs/promises'
import { Hono } from 'hono'
import { resolve } from 'pathe'
import type { AppEnv } from './env'
import authApp from './auth'
import pluginsApp from './plugins'

const app = new Hono<AppEnv>()
	.get('/', (c) => {
		return c.text('Hello Hono!')
	})
	.post('/build', async (c) => {
		const content = c.var.plugin_ctx.loader.buildSnapshot()
		const path = resolve(process.cwd(), 'snapshot.ts')
		await writeFile(path, content, 'utf8')
		return c.json({})
	})
	.route('/auth', authApp)
	.route('/plugins', pluginsApp)

export default app

export type AppType = typeof app
