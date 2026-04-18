import type { Context as PluxelContext } from '@pluxel/core'
import type { AnyElysiaApp } from '../http/elysia'
import type {
	VerificationAuthorizeInput,
	VerificationPasskeyAuthenticationFinishInput,
	VerificationState,
	VerificationVerifyResult,
} from './types'
import {
	buildVerificationRedirectPath,
	VERIFICATION_COOKIE_NAME,
} from './transport'

function isSecureRequest(url: string | undefined, headers: Headers): boolean {
	const forwarded = headers.get('x-forwarded-proto')
	if (forwarded) {
		const first = forwarded.split(',')[0]?.trim().toLowerCase()
		if (first === 'https') return true
	}
	if (!url) return false
	try {
		return new URL(url).protocol === 'https:'
	} catch {
		return false
	}
}

function escapeHtml(input: string): string {
	return input
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
}

function escapeJsString(input: string): string {
	return input
		.replaceAll('\\', '\\\\')
		.replaceAll("'", "\\'")
		.replaceAll('\n', '\\n')
}

function verificationStatusText(state: VerificationState): string {
	if (state.allow) return 'Host verification is already satisfied.'
	if (state.reason === 'misconfigured') return 'Host verification is enabled but credentials are missing.'
	return 'Host verification is required before continuing.'
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

function buildLogoutCookie(input: VerificationAuthorizeInput = {}): string {
	const headers = input.headers ?? input.request?.headers ?? new Headers()
	const secure = isSecureRequest(input.url ?? input.request?.url, headers)
	return `${VERIFICATION_COOKIE_NAME}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`
}

type VerificationFormRouteInput = {
	request: Request
	set: { headers: Record<string, string | number> }
	status: (code: number, body: unknown) => unknown
}

function passkeyScript(options: {
	returnTo: string
	startPath: string
	verifyPath: string
}): string {
	return `
const passkeyButton = document.getElementById('passkey-button');
const usernameInput = document.getElementById('passkey-username');
const errorText = document.getElementById('passkey-error');
const returnTo = '${escapeJsString(options.returnTo)}';
const startPath = '${escapeJsString(options.startPath)}';
const verifyPath = '${escapeJsString(options.verifyPath)}';

function setError(message) {
  if (errorText) errorText.textContent = message || '';
}

function b64urlToUint8Array(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function uint8ArrayToB64url(value) {
  let raw = '';
  for (let i = 0; i < value.length; i++) raw += String.fromCharCode(value[i]);
  return btoa(raw).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/g, '');
}

function mapRequestOptions(input) {
  return {
    challenge: b64urlToUint8Array(input.challenge),
    rpId: input.rpId,
    timeout: input.timeout,
    userVerification: input.userVerification,
    allowCredentials: input.allowCredentials.map((entry) => ({
      type: entry.type,
      id: b64urlToUint8Array(entry.id),
      transports: entry.transports,
    })),
  };
}

async function startPasskey() {
  setError('');
  const username = usernameInput && usernameInput.value ? usernameInput.value.trim() : '';
  if (!username) {
    setError('Username is required.');
    return;
  }
  if (!window.PublicKeyCredential || !window.isSecureContext) {
    setError('Passkey requires a secure browser context.');
    return;
  }

  passkeyButton.disabled = true;
  try {
    const optionsRes = await fetch(startPath, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username }),
      credentials: 'same-origin',
    });
    const optionsPayload = await optionsRes.json();
    if (!optionsRes.ok) throw new Error(optionsPayload?.message || 'Unable to start passkey verification.');

    const credential = await navigator.credentials.get({
      publicKey: mapRequestOptions(optionsPayload),
    });
    if (!credential || credential.type !== 'public-key') throw new Error('Passkey verification was cancelled.');

    const assertion = credential;
    const response = assertion.response;
    const verifyRes = await fetch(verifyPath, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username,
        returnTo,
        credential: {
          id: assertion.id,
          rawId: uint8ArrayToB64url(new Uint8Array(assertion.rawId)),
          type: assertion.type,
          authenticatorAttachment: assertion.authenticatorAttachment || undefined,
          clientExtensionResults: assertion.getClientExtensionResults ? assertion.getClientExtensionResults() : {},
          response: {
            clientDataJSON: uint8ArrayToB64url(new Uint8Array(response.clientDataJSON)),
            authenticatorData: uint8ArrayToB64url(new Uint8Array(response.authenticatorData)),
            signature: uint8ArrayToB64url(new Uint8Array(response.signature)),
            userHandle: response.userHandle ? uint8ArrayToB64url(new Uint8Array(response.userHandle)) : undefined,
          },
        },
      }),
      credentials: 'same-origin',
    });
    const verifyPayload = await verifyRes.json().catch(() => ({}));
    if (!verifyRes.ok) throw new Error(verifyPayload?.message || 'Passkey verification failed.');
    window.location.assign(verifyPayload?.redirectTo || returnTo);
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error));
  } finally {
    passkeyButton.disabled = false;
  }
}

if (passkeyButton) passkeyButton.addEventListener('click', () => { void startPasskey(); });
`
}

function renderVerificationPage(
	ctx: PluxelContext,
	request: Request,
	options: {
		returnTo?: string
		error?: string
	} = {},
): string {
	const url = new URL(request.url)
	const verification = ctx.root.verification.describe({ request })
	const returnTo = sanitizeReturnTo(request, options.returnTo ?? url.searchParams.get('returnTo'))
	const showConfiguredForm = verification.users.length > 0

	let verificationBody = `<p>Host verification users are not configured. Open <code>/security</code> to set them explicitly.</p>`
	if (showConfiguredForm && verification.method === 'password') {
		verificationBody = `<form method="POST" action="./verify/password" class="stack">
        <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}" />
        <label>Username</label>
        <input name="username" autocomplete="username" />
        <label>Password</label>
        <input name="password" type="password" autocomplete="current-password" />
        <button type="submit">Verify</button>
      </form>`
	}
	if (showConfiguredForm && verification.method === 'otp') {
		verificationBody = `<form method="POST" action="./verify/otp" class="stack">
        <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}" />
        <label>Username</label>
        <input name="username" autocomplete="username" />
        <label>OTP Code</label>
        <input name="code" inputmode="numeric" autocomplete="one-time-code" />
        <button type="submit">Verify</button>
      </form>`
	}
	if (showConfiguredForm && verification.method === 'passkey') {
		verificationBody = `<div class="stack">
        <label>Username</label>
        <input id="passkey-username" autocomplete="username webauthn" />
        <button type="button" id="passkey-button">Verify With Passkey</button>
        <p id="passkey-error" class="error"></p>
      </div>
      <script>${passkeyScript({
				returnTo,
				startPath: './passkey/options',
				verifyPath: './passkey/verify',
			})}</script>`
	}

	return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Host Verification</title>
    <style>
      :root { color-scheme: light; font-family: "IBM Plex Sans", "Segoe UI", sans-serif; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background:
        radial-gradient(circle at top, rgba(255,225,189,0.75), transparent 45%),
        linear-gradient(135deg, #f7f1e8, #dbe7ef 60%, #f4ddd1); color: #1d2a34; }
      .card { width: min(460px, calc(100vw - 32px)); padding: 24px; border-radius: 18px; background: rgba(255,255,255,0.8); border: 1px solid rgba(29,42,52,0.14); box-shadow: 0 28px 60px rgba(32,40,47,0.16); backdrop-filter: blur(18px); }
      h1 { margin: 0 0 10px; font-size: 24px; line-height: 1.1; }
      p { margin: 0 0 14px; line-height: 1.5; color: rgba(29,42,52,0.82); }
      label { display: block; margin: 12px 0 6px; font-size: 13px; font-weight: 600; letter-spacing: 0.02em; text-transform: uppercase; color: rgba(29,42,52,0.72); }
      input { width: 100%; box-sizing: border-box; padding: 12px 14px; border-radius: 12px; border: 1px solid rgba(29,42,52,0.16); background: rgba(255,255,255,0.92); color: #1d2a34; }
      button { width: 100%; margin-top: 16px; padding: 12px 14px; border: 0; border-radius: 999px; background: #103d52; color: #f7f1e8; font-weight: 700; cursor: pointer; }
      button.secondary { background: rgba(16,61,82,0.12); color: #103d52; }
      .pill { display: inline-flex; align-items: center; gap: 8px; margin-bottom: 16px; padding: 6px 10px; border-radius: 999px; background: rgba(16,61,82,0.1); font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; }
      .error { margin: 12px 0 0; color: #8f1d1d; font-weight: 600; }
      .stack { display: grid; gap: 12px; }
    </style>
  </head>
  <body>
    <main class="card">
      <div class="pill">${escapeHtml(verification.mode)} · ${escapeHtml(verification.method)}</div>
      <h1>Host Verification</h1>
      <p>${escapeHtml(verificationStatusText(verification))}</p>
      ${options.error ? `<p class="error">${escapeHtml(options.error)}</p>` : ''}
      ${verificationBody}
      <form method="POST" action="./logout">
        <button type="submit" class="secondary">Clear Session</button>
      </form>
    </main>
  </body>
</html>`
}

function jsonNoStore(data: unknown, status = 200, headers?: HeadersInit) {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			'cache-control': 'no-store',
			'content-type': 'application/json; charset=utf-8',
			...headers,
		},
	})
}

function readStringFormValue(form: FormData, key: string): string {
	return String(form.get(key) ?? '')
}

function readJsonString(value: unknown): string {
	return typeof value === 'string' ? value : ''
}

function renderVerificationFailure(
	ctx: PluxelContext,
	request: Request,
	set: VerificationFormRouteInput['set'],
	returnTo: string,
): string {
	set.headers['cache-control'] = 'no-store'
	set.headers['content-type'] = 'text/html; charset=utf-8'
	return renderVerificationPage(ctx, request, {
		returnTo,
		error: 'Verification failed.',
	})
}

function redirectAfterVerification(returnTo: string, result: VerificationVerifyResult): Response {
	return new Response(null, {
		status: 302,
		headers: {
			'cache-control': 'no-store',
			location: returnTo,
			...(result.cookie ? { 'set-cookie': result.cookie } : {}),
		},
	})
}

async function handleFormVerification(
	ctx: PluxelContext,
	input: VerificationFormRouteInput,
	verify: (request: Request, form: FormData) => VerificationVerifyResult,
): Promise<Response | unknown> {
	const form = await input.request.formData().catch((): FormData | null => null)
	if (!form) return input.status(400, 'Bad Request')

	const returnTo = sanitizeReturnTo(input.request, readStringFormValue(form, 'returnTo'))
	const result = verify(input.request, form)
	if (!result.allow) {
		return renderVerificationFailure(ctx, input.request, input.set, returnTo)
	}
	return redirectAfterVerification(returnTo, result)
}

export function createVerificationRoutes(ctx: PluxelContext, app: AnyElysiaApp): AnyElysiaApp {
	return app
		.get('/', ({ request, set }) => {
			const verification = ctx.root.verification.describe({ request })
			if (verification.mode === 'bypass') {
				return new Response(null, {
					status: 302,
					headers: {
						'cache-control': 'no-store',
						location: sanitizeReturnTo(
							request,
							new URL(request.url).searchParams.get('returnTo'),
						),
					},
				})
			}
			set.headers['cache-control'] = 'no-store'
			set.headers['content-type'] = 'text/html; charset=utf-8'
			return renderVerificationPage(ctx, request)
		})
		.post('/verify/password', async ({ request, set, status }) =>
			await handleFormVerification(ctx, { request, set, status }, (nextRequest, form) =>
				ctx.root.verification.verifyPassword({
					request: nextRequest,
					credentials: {
						username: readStringFormValue(form, 'username'),
						password: readStringFormValue(form, 'password'),
					},
				}),
			),
		)
		.post('/verify/otp', async ({ request, set, status }) =>
			await handleFormVerification(ctx, { request, set, status }, (nextRequest, form) =>
				ctx.root.verification.verifyOtp({
					request: nextRequest,
					credentials: {
						username: readStringFormValue(form, 'username'),
						code: readStringFormValue(form, 'code'),
					},
				}),
			),
		)
		.post('/passkey/options', async ({ request, status }) => {
			const body = await request.json().catch((): null => null)
			if (!body || typeof body !== 'object') {
				return status(400, { ok: false, code: 'invalid_verification_input' })
			}
			try {
				const options = await ctx.root.verification.beginPasskeyAuthentication({
					request,
					username: readJsonString((body as { username?: unknown }).username),
				})
				return jsonNoStore(options)
			} catch (error) {
				return jsonNoStore(
					{
						ok: false,
						message: error instanceof Error ? error.message : 'Unable to start passkey verification.',
					},
					400,
				)
			}
		})
		.post('/passkey/verify', async ({ request, status }) => {
			const body = await request.json().catch((): null => null)
			if (!body || typeof body !== 'object') {
				return status(400, { ok: false, code: 'invalid_verification_input' })
			}
			const returnTo = sanitizeReturnTo(
				request,
				readJsonString((body as { returnTo?: unknown }).returnTo),
			)
			try {
				const result = await ctx.root.verification.finishPasskeyAuthentication({
					request,
					username: readJsonString((body as { username?: unknown }).username),
					credential: (body as VerificationPasskeyAuthenticationFinishInput).credential,
				})
				if (!result.allow) {
					return jsonNoStore({ ok: false, message: 'Passkey verification failed.' }, 401)
				}
				return jsonNoStore(
					{ ok: true, redirectTo: returnTo },
					200,
					result.cookie ? { 'set-cookie': result.cookie } : undefined,
				)
			} catch (error) {
				return jsonNoStore(
					{
						ok: false,
						message: error instanceof Error ? error.message : 'Passkey verification failed.',
					},
					400,
				)
			}
		})
		.post('/logout', ({ request }) => {
			ctx.root.verification.clear()
			return new Response(null, {
				status: 302,
				headers: {
					'cache-control': 'no-store',
					'set-cookie': buildLogoutCookie({ request }),
					location: buildVerificationRedirectPath(),
				},
			})
		})
}
