import type { Context as PluxelContext } from '@pluxel/core'
import type { AnyElysiaApp } from '../http/elysia'
import { buildVerificationRedirectPath } from './transport'

function escapeHtml(input: string): string {
	return input
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
}

function sanitizeReturnTo(request: Request, raw: string | null | undefined): string {
	if (!raw) return '/'
	try {
		const resolved = new URL(raw, request.url)
		const current = new URL(request.url)
		if (resolved.origin !== current.origin) return '/'
		const next = `${resolved.pathname}${resolved.search}${resolved.hash}`
		return next.startsWith('/') ? next : '/'
	} catch {
		return '/'
	}
}

function statusText(reason?: string): string {
	switch (reason) {
		case 'missing_oidc':
			return 'Public admin access requires an OIDC configuration.'
		case 'unauthenticated':
			return 'OIDC authentication is required for Pluxel admin access.'
		case 'invalid_token':
			return 'The provided OIDC token is invalid.'
		case 'forbidden':
			return 'The authenticated OIDC identity is not allowed to administer this host.'
		default:
			return 'OIDC authentication is required for Pluxel admin access.'
	}
}

async function renderVerificationPage(ctx: PluxelContext, request: Request): Promise<string> {
	const url = new URL(request.url)
	const verification = await ctx.root.verification.describe({ request })
	const returnTo = sanitizeReturnTo(request, url.searchParams.get('returnTo'))
	const action =
		verification.reason === 'missing_oidc'
			? '<p>Configure public management access with an OIDC issuer, or run this host in private mode.</p>'
			: `<p>Authenticate through the configured OIDC provider, then return to <code>${escapeHtml(returnTo)}</code>.</p>`

	return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Pluxel Admin Access</title>
    <style>
      :root { color-scheme: light; font-family: "IBM Plex Sans", "Segoe UI", sans-serif; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f5f7f9; color: #1d2a34; }
      main { width: min(520px, calc(100vw - 32px)); padding: 24px; border: 1px solid rgba(29,42,52,0.14); border-radius: 8px; background: #fff; box-shadow: 0 16px 48px rgba(32,40,47,0.12); }
      h1 { margin: 0 0 10px; font-size: 24px; line-height: 1.15; }
      p { margin: 0 0 14px; line-height: 1.55; color: rgba(29,42,52,0.78); }
      code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.95em; }
      a { color: #0f5d7a; font-weight: 700; }
      .pill { display: inline-flex; margin-bottom: 14px; padding: 4px 8px; border-radius: 999px; background: #e8eef2; font-size: 12px; font-weight: 700; text-transform: uppercase; }
    </style>
  </head>
  <body>
    <main>
      <div class="pill">${escapeHtml(verification.exposure)} · ${escapeHtml(verification.provider)}</div>
      <h1>Pluxel Admin Access</h1>
      <p>${escapeHtml(statusText(verification.reason))}</p>
      ${action}
      <p><a href="${escapeHtml(buildVerificationRedirectPath(returnTo))}">Retry</a></p>
    </main>
  </body>
</html>`
}

export function createVerificationRoutes(ctx: PluxelContext, app: AnyElysiaApp): AnyElysiaApp {
	return app.get('/', async ({ request, set }) => {
		const verification = await ctx.root.verification.describe({ request })
		if (verification.allow) {
			return new Response(null, {
				status: 302,
				headers: {
					'cache-control': 'no-store',
					location: sanitizeReturnTo(request, new URL(request.url).searchParams.get('returnTo')),
				},
			})
		}
		set.headers['cache-control'] = 'no-store'
		set.headers['content-type'] = 'text/html; charset=utf-8'
		return await renderVerificationPage(ctx, request)
	})
}
