import { Hono } from 'hono'
import type { AuthGuardResult } from '../../services/hono/AuthGuardService'
import type { AppEnv } from './env'

const authApp = new Hono<AppEnv>()

authApp.get('/guard', async (c) => {
	const path = c.req.query('path') ?? '/'
	const request = c.req.raw
	const honoService = c.var.plugin_ctx.honoService

	if (!honoService.isAuthGuardEnabled()) {
		return c.json<AuthGuardResult>({ allow: true }, 200)
	}

	const requestUrl = tryParseUrl(request.url)
	const result = await honoService.evaluateAuthGuard({
		path,
		method: c.req.query('method') ?? c.req.method,
		headers: request.headers,
		request,
		url: requestUrl,
	})

	return c.json<AuthGuardResult>(result ?? { allow: true }, 200)
})

function tryParseUrl(input: string): URL | undefined {
	try {
		return new URL(input)
	} catch {
		return undefined
	}
}

export default authApp
