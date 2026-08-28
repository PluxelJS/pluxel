import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { AuthDecision, AuthMethod, AuthRequestContext } from './contracts.ts'

const MOUNT_PATH = '/__pluxel/admin-access'
const CSRF_COOKIE = 'pluxel_admin_csrf'
const MAX_FORM_BYTES = 16 * 1_024
const MAX_RETURN_TO = 2_048

export type SetupSnapshot = Readonly<{
	method: AuthMethod
	ready: boolean
	vaultAvailable: boolean
	credentialsInvalid: boolean
	accountName?: string
	clientSecretRequired?: boolean
	clientSecretConfigured?: boolean
}>

export type LoginResult =
	| Readonly<{ ok: true; cookie: string }>
	| Readonly<{ ok: false; unavailable?: boolean }>

export type TotpEnrollmentView = Readonly<{
	id: string
	secret: string
	provisioningUri: string
}>

export type SetupResult = Readonly<{ ok: true }> | Readonly<{ ok: false; message: string }>

export type AuthHttpActions = Readonly<{
	snapshot(): SetupSnapshot
	authorize(request: Request, context: AuthRequestContext): Promise<AuthDecision>
	login(input: {
		username: string
		password: string
		otp?: string
		secure: boolean
	}): Promise<LoginResult>
	setupPassword(input: {
		username: string
		password: string
		passwordConfirmation: string
	}): Promise<SetupResult>
	beginTotp(input: {
		username: string
		password: string
		passwordConfirmation: string
	}): Promise<TotpEnrollmentView | SetupResult>
	confirmTotp(input: { enrollmentId: string; otp: string }): Promise<SetupResult>
	setupOidcSecret(secret: string): Promise<SetupResult>
	startOidc(request: Request, returnTo: string): Promise<Response>
	finishOidc(
		request: Request,
	): Promise<
		| Readonly<{ ok: true; cookie: string; clearStateCookie: string; returnTo: string }>
		| Readonly<{ ok: false; unavailable: boolean; clearStateCookie: string }>
	>
	logout(request: Request, context: AuthRequestContext): string
}>

function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;')
}

function page(title: string, content: string): string {
	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }
    main { width: min(34rem, calc(100vw - 2rem)); border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: .75rem; padding: 1.5rem; box-sizing: border-box; }
    h1 { margin: 0 0 1rem; font-size: 1.5rem; }
    p { line-height: 1.5; }
    label { display: grid; gap: .35rem; margin: .8rem 0; }
    input { font: inherit; padding: .65rem; border: 1px solid color-mix(in srgb, CanvasText 28%, transparent); border-radius: .4rem; }
    button, a.button { display: inline-block; font: inherit; padding: .65rem 1rem; border: 0; border-radius: .4rem; background: #2563eb; color: white; text-decoration: none; cursor: pointer; }
    code { overflow-wrap: anywhere; }
    .error { color: #dc2626; }
    .muted { opacity: .72; }
  </style>
</head>
<body><main>${content}</main></body>
</html>`
}

function html(content: string, status: number = 200, cookies: readonly string[] = []): Response {
	const headers = new Headers({
		'cache-control': 'no-store',
		'content-security-policy':
			"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
		'content-type': 'text/html; charset=utf-8',
		'referrer-policy': 'no-referrer',
		'x-content-type-options': 'nosniff',
		'x-frame-options': 'DENY',
	})
	for (const cookie of cookies) headers.append('set-cookie', cookie)
	return new Response(content, { status, headers })
}

function redirect(path: string, cookies: readonly string[] = []): Response {
	const headers = new Headers({ location: path, 'cache-control': 'no-store' })
	for (const cookie of cookies) headers.append('set-cookie', cookie)
	return new Response(null, { status: 303, headers })
}

function relativePath(request: Request): string {
	const path = new URL(request.url).pathname
	if (path === MOUNT_PATH) return '/'
	if (path.startsWith(`${MOUNT_PATH}/`)) return path.slice(MOUNT_PATH.length)
	return path
}

function safeReturnTo(value: string | null | undefined): string {
	if (!value || value.length > MAX_RETURN_TO || !value.startsWith('/') || value.startsWith('//')) {
		return '/'
	}
	try {
		const url = new URL(value, 'https://pluxel.invalid')
		return url.origin === 'https://pluxel.invalid' ? `${url.pathname}${url.search}${url.hash}` : '/'
	} catch {
		return '/'
	}
}

function cookieValue(request: Request, name: string): string | undefined {
	const cookie = request.headers.get('cookie')
	if (!cookie || Buffer.byteLength(cookie) > 8_192) return undefined
	for (const entry of cookie.split(';')) {
		const separator = entry.indexOf('=')
		if (separator >= 0 && entry.slice(0, separator).trim() === name) {
			return entry.slice(separator + 1).trim()
		}
	}
	return undefined
}

function issueCsrf(secure: boolean): { token: string; cookie: string } {
	const token = randomBytes(32).toString('base64url')
	return {
		token,
		cookie: `${CSRF_COOKIE}=${token}; Path=${MOUNT_PATH}; HttpOnly; SameSite=Strict; Max-Age=1800${secure ? '; Secure' : ''}`,
	}
}

function safeEqual(left: string, right: string): boolean {
	const a = createHash('sha256').update(left).digest()
	const b = createHash('sha256').update(right).digest()
	return timingSafeEqual(a, b)
}

function sameOrigin(request: Request): boolean {
	if ((request.headers.get('sec-fetch-site') ?? '').toLowerCase() === 'cross-site') return false
	const origin = request.headers.get('origin')
	if (!origin) return false
	try {
		return origin === new URL(request.url).origin
	} catch {
		return false
	}
}

async function readForm(request: Request): Promise<URLSearchParams | undefined> {
	const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
	if (contentType !== 'application/x-www-form-urlencoded') return undefined
	const declared = Number(request.headers.get('content-length'))
	if (Number.isFinite(declared) && declared > MAX_FORM_BYTES) return undefined
	const text = await readBoundedText(request.body, MAX_FORM_BYTES)
	return text === undefined ? undefined : new URLSearchParams(text)
}

async function readBoundedText(
	body: ReadableStream<Uint8Array> | null,
	maxBytes: number,
): Promise<string | undefined> {
	if (!body) return ''
	const reader = body.getReader()
	const chunks: Buffer[] = []
	let bytes = 0
	try {
		while (true) {
			const chunk = await reader.read()
			if (chunk.done) break
			bytes += chunk.value.byteLength
			if (bytes > maxBytes) {
				await reader.cancel('Request body too large')
				return undefined
			}
			chunks.push(Buffer.from(chunk.value))
		}
	} finally {
		reader.releaseLock()
	}
	return Buffer.concat(chunks, bytes).toString('utf8')
}

function csrfValid(request: Request, form: URLSearchParams): boolean {
	const supplied = form.get('csrf') ?? ''
	const cookie = cookieValue(request, CSRF_COOKIE) ?? ''
	return /^[A-Za-z0-9_-]{43}$/.test(supplied) && safeEqual(supplied, cookie)
}

function errorPage(message: string, status: number = 400): Response {
	return html(
		page(
			'Authentication failed',
			`<h1>Authentication failed</h1><p class="error">${escapeHtml(message)}</p><p><a href="${MOUNT_PATH}/">Try again</a></p>`,
		),
		status,
	)
}

export class AuthHttpController {
	constructor(private readonly actions: AuthHttpActions) {}

	async handle(request: Request, context: AuthRequestContext): Promise<Response | undefined> {
		const path = relativePath(request)
		const method = request.method.toUpperCase()
		if (path === '/' && (method === 'GET' || method === 'HEAD')) {
			return this.landing(request, context)
		}
		if (path === '/login' && (method === 'GET' || method === 'HEAD')) {
			return this.landing(request, context)
		}
		if (path === '/login' && method === 'POST') return this.login(request, context)
		if (path === '/logout' && method === 'POST') return this.logout(request, context)
		if (path === '/setup' && (method === 'GET' || method === 'HEAD')) {
			if (!context.local) return errorPage('Not found.', 404)
			if (!(await this.setupAllowed(request, context))) {
				return errorPage('Authentication is required.', 401)
			}
			return this.setupPage(context)
		}
		if (path === '/setup' && method === 'POST') {
			if (!context.local) return errorPage('Not found.', 404)
			if (!(await this.setupAllowed(request, context))) {
				return errorPage('Authentication is required.', 401)
			}
			return this.setup(request, context)
		}
		if (path === '/oidc/start' && (method === 'GET' || method === 'HEAD')) {
			return this.startOidc(request, context)
		}
		if (path === '/oidc/callback' && (method === 'GET' || method === 'HEAD')) {
			return this.finishOidc(request, context)
		}
		return undefined
	}

	private async setupAllowed(request: Request, context: AuthRequestContext): Promise<boolean> {
		if (!this.actions.snapshot().ready) return true
		const decision = await this.actions.authorize(request, context)
		return decision.allow
	}

	private landing(request: Request, context: AuthRequestContext): Response {
		const snapshot = this.actions.snapshot()
		if (!snapshot.ready) {
			if (context.local) return redirect(`${MOUNT_PATH}/setup`)
			return html(
				page(
					'Management setup required',
					'<h1>Management setup required</h1><p>Connect through an SSH tunnel and open this host on localhost to finish authentication setup.</p>',
				),
				503,
			)
		}
		const returnTo = safeReturnTo(new URL(request.url).searchParams.get('returnTo'))
		if (snapshot.method === 'oidc') {
			return html(
				page(
					'Pluxel sign in',
					`<h1>Pluxel sign in</h1><p>Continue with the configured identity provider.</p><a class="button" href="${MOUNT_PATH}/oidc/start?returnTo=${encodeURIComponent(returnTo)}">Continue</a>`,
				),
			)
		}
		const csrf = issueCsrf(context.secure)
		const otp =
			snapshot.method === 'password-totp'
				? '<label>One-time code<input name="otp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></label>'
				: ''
		return html(
			page(
				'Pluxel sign in',
				`<h1>Pluxel sign in</h1><form method="post" action="${MOUNT_PATH}/login"><input type="hidden" name="csrf" value="${csrf.token}"><input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}"><label>Account<input name="username" autocomplete="username" maxlength="64" required></label><label>Password<input type="password" name="password" autocomplete="current-password" maxlength="1024" required></label>${otp}<button type="submit">Sign in</button></form>`,
			),
			200,
			[csrf.cookie],
		)
	}

	private async login(request: Request, context: AuthRequestContext): Promise<Response> {
		if (!context.local && !context.secure) return errorPage('A secure connection is required.', 400)
		const form = await readForm(request)
		if (!form || !sameOrigin(request) || !csrfValid(request, form)) {
			return errorPage('The sign-in request could not be accepted.')
		}
		const result = await this.actions.login({
			username: form.get('username') ?? '',
			password: form.get('password') ?? '',
			...(form.has('otp') ? { otp: form.get('otp') ?? '' } : {}),
			secure: context.secure,
		})
		if (result.ok === false) {
			return errorPage(
				result.unavailable
					? 'Authentication is temporarily unavailable.'
					: 'The supplied credentials were not accepted.',
				result.unavailable ? 503 : 401,
			)
		}
		return redirect(safeReturnTo(form.get('returnTo')), [result.cookie])
	}

	private async logout(request: Request, context: AuthRequestContext): Promise<Response> {
		const form = await readForm(request)
		if (!form || !sameOrigin(request) || !csrfValid(request, form)) {
			return errorPage('The logout request could not be accepted.')
		}
		return redirect(MOUNT_PATH, [this.actions.logout(request, context)])
	}

	private setupPage(context: AuthRequestContext, message?: string): Response {
		const snapshot = this.actions.snapshot()
		const csrf = issueCsrf(context.secure)
		let form: string
		if (snapshot.method === 'oidc' && !snapshot.clientSecretRequired) {
			form =
				'<p>The public OIDC client is configured and does not require a stored client secret.</p>'
		} else if (!snapshot.vaultAvailable) {
			form =
				'<p class="error">The host must enable and unlock Vault before credentials can be configured.</p>'
		} else if (snapshot.method === 'oidc') {
			form = snapshot.clientSecretConfigured
				? '<p>The confidential client secret is configured. Submit a new value only to replace it.</p>'
				: '<p>Store the confidential OIDC client secret to activate remote management.</p>'
			form += `<form method="post" action="${MOUNT_PATH}/setup"><input type="hidden" name="csrf" value="${csrf.token}"><input type="hidden" name="action" value="oidc-secret"><label>Client secret<input type="password" name="clientSecret" autocomplete="new-password" maxlength="4096" required></label><button type="submit">Save secret</button></form>`
		} else {
			const action = snapshot.method === 'password-totp' ? 'begin-totp' : 'password'
			form = `<form method="post" action="${MOUNT_PATH}/setup"><input type="hidden" name="csrf" value="${csrf.token}"><input type="hidden" name="action" value="${action}"><label>Account<input name="username" autocomplete="username" maxlength="64" value="${escapeHtml(snapshot.accountName ?? '')}" required></label><label>New password<input type="password" name="password" autocomplete="new-password" maxlength="1024" minlength="12" required></label><label>Confirm password<input type="password" name="passwordConfirmation" autocomplete="new-password" maxlength="1024" minlength="12" required></label><button type="submit">${snapshot.method === 'password-totp' ? 'Continue to OTP setup' : 'Save account'}</button></form>`
		}
		const notice = message ? `<p>${escapeHtml(message)}</p>` : ''
		const invalid = snapshot.credentialsInvalid
			? '<p class="error">Stored credentials are invalid. Saving new credentials will replace them.</p>'
			: ''
		return html(
			page(
				'Pluxel authentication setup',
				`<h1>Authentication setup</h1><p class="muted">This page is available only through localhost.</p>${notice}${invalid}${form}`,
			),
			200,
			[csrf.cookie],
		)
	}

	private async setup(request: Request, context: AuthRequestContext): Promise<Response> {
		const form = await readForm(request)
		if (!form || !sameOrigin(request) || !csrfValid(request, form)) {
			return errorPage('The setup request could not be accepted.')
		}
		const action = form.get('action')
		try {
			if (action === 'password') {
				const result = await this.actions.setupPassword({
					username: form.get('username') ?? '',
					password: form.get('password') ?? '',
					passwordConfirmation: form.get('passwordConfirmation') ?? '',
				})
				if (result.ok === false) return errorPage(result.message)
				return this.setupPage(context, 'Account saved.')
			}
			if (action === 'begin-totp') {
				const result = await this.actions.beginTotp({
					username: form.get('username') ?? '',
					password: form.get('password') ?? '',
					passwordConfirmation: form.get('passwordConfirmation') ?? '',
				})
				if ('ok' in result) {
					return result.ok === false
						? errorPage(result.message)
						: this.setupPage(context, 'Account saved.')
				}
				const csrf = cookieValue(request, CSRF_COOKIE) ?? ''
				return html(
					page(
						'Confirm authenticator',
						`<h1>Confirm authenticator</h1><p>Add this secret to your authenticator, then enter its current code.</p><p><code>${escapeHtml(result.secret)}</code></p><p class="muted"><code>${escapeHtml(result.provisioningUri)}</code></p><form method="post" action="${MOUNT_PATH}/setup"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="action" value="confirm-totp"><input type="hidden" name="enrollmentId" value="${escapeHtml(result.id)}"><label>One-time code<input name="otp" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required></label><button type="submit">Save account</button></form>`,
					),
				)
			}
			if (action === 'confirm-totp') {
				const result = await this.actions.confirmTotp({
					enrollmentId: form.get('enrollmentId') ?? '',
					otp: form.get('otp') ?? '',
				})
				if (result.ok === false) return errorPage(result.message)
				return this.setupPage(context, 'Account and OTP saved.')
			}
			if (action === 'oidc-secret') {
				const result = await this.actions.setupOidcSecret(form.get('clientSecret') ?? '')
				if (result.ok === false) return errorPage(result.message)
				return this.setupPage(context, 'Client secret saved.')
			}
		} catch {
			return errorPage('The credentials could not be saved.', 503)
		}
		return errorPage('Invalid setup action.')
	}

	private async startOidc(request: Request, context: AuthRequestContext): Promise<Response> {
		const snapshot = this.actions.snapshot()
		if (snapshot.method !== 'oidc' || !snapshot.ready)
			return errorPage('Authentication is unavailable.', 503)
		if (!context.secure) return errorPage('A secure connection is required.')
		try {
			return await this.actions.startOidc(
				request,
				safeReturnTo(new URL(request.url).searchParams.get('returnTo')),
			)
		} catch {
			return errorPage('Authentication is temporarily unavailable.', 503)
		}
	}

	private async finishOidc(request: Request, context: AuthRequestContext): Promise<Response> {
		if (!context.secure) return errorPage('A secure connection is required.')
		const result = await this.actions.finishOidc(request)
		if (result.ok === false) {
			return html(
				page(
					'Authentication failed',
					'<h1>Authentication failed</h1><p>The identity response could not be accepted.</p><p><a href="/">Try again</a></p>',
				),
				result.unavailable ? 503 : 401,
				[result.clearStateCookie],
			)
		}
		return redirect(result.returnTo, [result.cookie, result.clearStateCookie])
	}
}
