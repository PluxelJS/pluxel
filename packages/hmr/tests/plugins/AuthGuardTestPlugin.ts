import { BasePlugin, Plugin } from '@pluxel/core'
import type { HonoWithAppEnvType } from '../../src/services/hono/env'

const COOKIE_NAME = 'pluxel-auth'

function hasAuthCookie(header: string | null | undefined): boolean {
	if (!header) return false
	return header
		.split(';')
		.map((v) => v.trim())
		.some((pair) => pair === `${COOKIE_NAME}=1`)
}

@Plugin({ name: 'AuthGuardTest', type: 'event' })
export class AuthGuardTestPlugin extends BasePlugin {
	override async init() {
		this.ctx.authGuard.register({
			redirectPath: '/auth',
			authorize: ({ headers }) => hasAuthCookie(headers.get('cookie')),
		})

		this.ctx.honoService.modifyApp((app: HonoWithAppEnvType) => {
			app.get('/auth', (c) => {
				return c.html(`<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Auth Test</title>
  </head>
  <body>
    <h1>Auth Test</h1>
    <button id="verify">Verify</button>
    <script>
      document.getElementById('verify').addEventListener('click', async () => {
        await fetch('/auth/verify', { method: 'POST' });
        window.location.assign('/');
      });
    </script>
  </body>
</html>`)
			})

			app.post('/auth/verify', (c) => {
				return c.text('verified', 200, {
					// Stateless "verification": just drop a cookie that authorize() checks.
					'Set-Cookie': `${COOKIE_NAME}=1; Path=/; SameSite=Lax`,
					'Cache-Control': 'no-store',
				})
			})
		})
	}
}

