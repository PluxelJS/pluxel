import { Hono } from 'hono'
import { getHmrMcpHttpHandler } from '../mcp'
import type { AppEnv } from '../../services/http/hono-env'

export const mcpApp = new Hono<AppEnv>().all('*', async (c) => {
	const ctx = c.var.plugin_ctx
	const handler = getHmrMcpHttpHandler(ctx)
	return await handler(c.req.raw)
})

export default mcpApp
