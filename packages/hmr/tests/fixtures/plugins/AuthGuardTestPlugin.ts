import { BasePlugin, Plugin } from '@pluxel/hmr'

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

		this.ctx.http.host.routes(
			(app) =>
				app
					.get('/', ({ set }) => {
						set.headers['content-type'] = 'text/html; charset=utf-8'
						return `<!DOCTYPE html>
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
</html>`
					})
					.post('/verify', ({ set }) => {
						set.headers['set-cookie'] = `${COOKIE_NAME}=1; Path=/; SameSite=Lax`
						set.headers['cache-control'] = 'no-store'
						return 'verified'
					}),
			{
				id: 'AuthGuardTest:auth',
				path: '/auth',
			},
		)
	}
}
