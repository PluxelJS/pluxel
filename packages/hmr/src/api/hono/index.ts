import { writeFile } from 'node:fs/promises'
import { Hono } from 'hono'
import { resolve } from 'pathe'
import loggerApp from '../../services/logger/api'
import authApp from './auth'
import type { AppEnv } from './env'
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
	.route('/logs', loggerApp)
	.all('/graphql', (c) => c.var.plugin_ctx.internalGraphql.fetch(c.req.raw, { hono: c } as any))

export default app

export type AppType = typeof app
