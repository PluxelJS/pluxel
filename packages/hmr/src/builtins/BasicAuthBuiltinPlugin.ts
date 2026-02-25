import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import {
	__setConfigSource__ as __pluxelSetConfigSource__,
	BasePlugin,
	Config,
	Plugin,
} from '@pluxel/core'
import { f, v } from '../config'
import type { HonoWithAppEnvType } from '../services/hono/env'
import {
	b64url,
	b64urlDecode,
	hashPasswordScrypt,
	verifyPasswordScrypt,
} from './basic-auth/password'

type AuthConfig = {
	username?: string
	/**
	 * Plaintext password input field (will be converted to passwordHash on save/init).
	 * This field is kept for UX and backward-compat; it should not be persisted long-term.
	 */
	password?: string
	/** Stored password hash (scrypt). */
	passwordHash?: string
}

const AuthSchema = v.object({
	username: v.pipe(
		v.optional(v.string(), ''),
		f.formMeta({
			label: '用户名',
			description: '启用 BasicAuth 插件后，访问 UI / 内部 API 需要先登录。',
		}),
		f.stringMeta({ placeholder: 'admin' }),
	),
	password: v.pipe(
		v.optional(v.string(), ''),
		f.formMeta({
			label: '密码',
			description: '保存后会自动转为 hash 存储；此字段会被清空（不会长期保存明文）。',
		}),
		f.stringMeta({ control: 'password', placeholder: '********（保存后会清空）' }),
	),
	passwordHash: v.pipe(v.optional(v.string(), ''), f.formMeta({ hidden: true }), f.stringMeta({})),
})

function sign(secret: string, payloadB64: string): string {
	return b64url(createHmac('sha256', secret).update(payloadB64).digest())
}

function parseCookie(header: string | null | undefined, key: string): string | undefined {
	if (!header) return undefined
	const parts = header.split(';')
	for (const part of parts) {
		const [k, ...rest] = part.trim().split('=')
		if (!k) continue
		if (k !== key) continue
		return rest.join('=') || undefined
	}
	return undefined
}

function setCookie(resHeaders: Headers, cookie: string) {
	// `Set-Cookie` must not be combined with commas. Use append.
	resHeaders.append('set-cookie', cookie)
}

function isSecureRequest(url: string, headers: Headers): boolean {
	const forwarded = headers.get('x-forwarded-proto')
	if (forwarded) {
		const first = forwarded.split(',')[0]?.trim().toLowerCase()
		if (first === 'https') return true
	}
	try {
		return new URL(url).protocol === 'https:'
	} catch {
		return false
	}
}

@Plugin({ name: 'BasicAuth', type: 'event' })
export class BasicAuthBuiltinPlugin extends BasePlugin {
	@Config(AuthSchema)
	declare auth: AuthConfig

	private readonly cookieName = 'pluxel-auth'
	private readonly tokenTtlMs = 7 * 24 * 60 * 60 * 1000
	private readonly secret = b64url(randomBytes(32))

	override async init() {
		const pluginId = this.ctx.pluginInfo?.id ?? 'BasicAuth'
		const cfg0 = this.auth ?? {}

		// One-time migration: if user typed plaintext password, convert to scrypt hash and clear it.
		// (Do not keep plaintext in persisted config.)
		let cfg: AuthConfig = cfg0
		if (typeof cfg0.password === 'string' && cfg0.password) {
			const next: AuthConfig = {
				...cfg0,
				passwordHash: hashPasswordScrypt(cfg0.password),
				password: '',
			}
			this.ctx.configService.patchConfig<{ auth: AuthConfig }>(pluginId, { auth: next })
			cfg = next
		}

		const storedUsername = typeof cfg.username === 'string' ? cfg.username : ''
		const storedPasswordHash = typeof cfg.passwordHash === 'string' ? cfg.passwordHash : ''
		if (!storedUsername || !storedPasswordHash) {
			throw new Error(
				'[BasicAuth] Missing credentials. Configure BasicAuth.auth.username and BasicAuth.auth.password (or passwordHash) before enabling the plugin.',
			)
		}

		// Must be sync: guard redirects to /auth; avoid a race with async/microtask rebuild.
		this.ctx.honoService.modifyAppNow((app: HonoWithAppEnvType) => {
			app.get('/auth', (c) => {
				const html = `<!doctype html>
	<html lang="zh">
	  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Pluxel 登录</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"; margin: 0; padding: 24px; background: #0b1220; color: #e5e7eb; }
      .card { max-width: 420px; margin: 8vh auto; padding: 20px; border-radius: 12px; background: rgba(15, 23, 42, 0.65); border: 1px solid rgba(148,163,184,0.20); }
      h1 { margin: 0 0 8px; font-size: 18px; }
      p { margin: 0 0 14px; color: rgba(226,232,240,0.8); font-size: 13px; line-height: 1.5; }
      label { display:block; font-size: 13px; margin: 10px 0 6px; color: rgba(226,232,240,0.9); }
      input { width: 100%; padding: 10px 12px; border-radius: 10px; border: 1px solid rgba(148,163,184,0.25); background: rgba(2,6,23,0.6); color: #e5e7eb; outline: none; }
      button { margin-top: 14px; width: 100%; padding: 10px 12px; border-radius: 10px; border: 1px solid rgba(99,102,241,0.45); background: rgba(99,102,241,0.18); color: #e5e7eb; cursor: pointer; }
      .muted { color: rgba(148,163,184,0.9); }
      .warn { color: #fbbf24; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Pluxel 登录</h1>
      <p class="muted">请输入账号密码。</p>
      <form method="POST" action="/auth/login">
        <label>用户名</label>
        <input name="username" autocomplete="username" />
        <label>密码</label>
        <input name="password" type="password" autocomplete="current-password" />
        <button type="submit">登录</button>
      </form>
      <form method="POST" action="/auth/logout">
        <button type="submit" style="margin-top: 10px; border-color: rgba(148,163,184,0.25); background: rgba(148,163,184,0.08);">清除登录态</button>
      </form>
    </div>
  </body>
</html>`

				return c.html(html, 200, { 'Cache-Control': 'no-store' })
			})

			app.post('/auth/login', async (c) => {
				const isSecure = isSecureRequest(c.req.url, c.req.raw.headers)

				let username = ''
				let password = ''
				try {
					const form = await c.req.raw.formData()
					username = String(form.get('username') ?? '')
					password = String(form.get('password') ?? '')
				} catch {
					return c.text('Bad Request', 400)
				}

				const ok = username === storedUsername && verifyPasswordScrypt(password, storedPasswordHash)
				if (!ok) return c.text('Unauthorized', 401)

				const exp = Date.now() + this.tokenTtlMs
				const payload = b64url(JSON.stringify({ u: username, exp }))
				const sig = sign(this.secret, payload)
				const token = `${payload}.${sig}`

				const headers = new Headers({
					'Cache-Control': 'no-store',
				})
				setCookie(
					headers,
					`${this.cookieName}=${token}; Path=/; Max-Age=${Math.floor(
						this.tokenTtlMs / 1000,
					)}; HttpOnly; SameSite=Lax${isSecure ? '; Secure' : ''}`,
				)
				headers.set('location', '/')
				return new Response(null, { status: 302, headers })
			})

			app.post('/auth/logout', (c) => {
				const isSecure = isSecureRequest(c.req.url, c.req.raw.headers)

				const headers = new Headers({
					'Cache-Control': 'no-store',
				})
				setCookie(
					headers,
					`${this.cookieName}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax${isSecure ? '; Secure' : ''}`,
				)
				headers.set('location', '/')
				return new Response(null, { status: 302, headers })
			})
		})

		this.ctx.authGuard.register({
			redirectPath: '/auth',
			authorize: ({ headers }) => {
				const token = parseCookie(headers.get('cookie'), this.cookieName)
				if (!token) return false
				const [payloadB64, sig] = token.split('.')
				if (!payloadB64 || !sig) return false

				let expected: string
				try {
					expected = sign(this.secret, payloadB64)
				} catch {
					return false
				}

				try {
					const a = Buffer.from(expected)
					const b = Buffer.from(sig)
					if (a.length !== b.length) return false
					if (!timingSafeEqual(a, b)) return false
				} catch {
					return false
				}

				try {
					const raw = b64urlDecode(payloadB64).toString('utf8')
					const data = JSON.parse(raw) as { u?: unknown; exp?: unknown }
					if (typeof data?.u !== 'string') return false
					if (typeof data?.exp !== 'number') return false
					if (Date.now() > data.exp) return false
					return data.u === storedUsername
				} catch {
					return false
				}
			},
		})
	}
}

// Builtins are imported directly by the host (not executed via the HMR runner),
// so they do not get configSourcePlugin's injected __setConfigSource__ calls.
// Provide the schema source explicitly so the UI can render the config form.
__pluxelSetConfigSource__(
	BasicAuthBuiltinPlugin,
	'auth',
	`v.object({
  username: v.pipe(
    v.optional(v.string(), ''),
    f.formMeta({ label: '用户名', description: '启用 BasicAuth 插件后，访问 UI / 内部 API 需要先登录。' }),
    f.stringMeta({ placeholder: 'admin' }),
  ),
  password: v.pipe(
    v.optional(v.string(), ''),
    f.formMeta({ label: '密码', description: '保存后会自动转为 hash 存储；此字段会被清空（不会长期保存明文）。' }),
    f.stringMeta({ control: 'password', placeholder: '********（保存后会清空）' }),
  ),
  passwordHash: v.pipe(
    v.optional(v.string(), ''),
    f.formMeta({ hidden: true }),
    f.stringMeta({}),
  ),
})`,
)
