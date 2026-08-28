import { createHash, randomBytes } from 'node:crypto'
import type { AuthMethod, AuthPrincipal } from './contracts.ts'

const SECURE_SESSION_COOKIE = '__Host-pluxel_admin_session'
const LOCAL_SESSION_COOKIE = 'pluxel_admin_local_session'
const SESSION_TTL_MS = 12 * 60 * 60 * 1_000
const MAX_SESSIONS = 2_048
const MAX_COOKIE_HEADER_BYTES = 8_192

type Session = Readonly<{
	principal: AuthPrincipal
	method: AuthMethod
	localOnly: boolean
	expiresAt: number
}>

function tokenDigest(token: string): string {
	return createHash('sha256').update(token).digest('base64url')
}

export function readCookie(request: Request, name: string): string | undefined {
	const header = request.headers.get('cookie')
	if (!header || Buffer.byteLength(header) > MAX_COOKIE_HEADER_BYTES) return undefined
	for (const part of header.split(';')) {
		const separator = part.indexOf('=')
		if (separator < 0 || part.slice(0, separator).trim() !== name) continue
		const value = part.slice(separator + 1).trim()
		return value.length <= 512 ? value : undefined
	}
	return undefined
}

export class SessionStore {
	private readonly sessions = new Map<string, Session>()

	create(
		principal: AuthPrincipal,
		method: AuthMethod,
		secure: boolean = true,
		now: number = Date.now(),
	): string {
		this.prune(now)
		while (this.sessions.size >= MAX_SESSIONS) {
			const oldest = this.sessions.keys().next().value as string | undefined
			if (!oldest) break
			this.sessions.delete(oldest)
		}
		const token = randomBytes(32).toString('base64url')
		this.sessions.set(
			tokenDigest(token),
			Object.freeze({ principal, method, localOnly: !secure, expiresAt: now + SESSION_TTL_MS }),
		)
		const name = secure ? SECURE_SESSION_COOKIE : LOCAL_SESSION_COOKIE
		return `${name}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1_000)}${secure ? '; Secure' : ''}`
	}

	read(
		request: Request,
		method: AuthMethod,
		allowLocalCookie: boolean = false,
		now: number = Date.now(),
	): AuthPrincipal | undefined {
		const candidates: readonly Readonly<{ token?: string; localOnly: boolean }>[] = [
			{ token: readCookie(request, SECURE_SESSION_COOKIE), localOnly: false },
			...(allowLocalCookie
				? [{ token: readCookie(request, LOCAL_SESSION_COOKIE), localOnly: true }]
				: []),
		]
		for (const candidate of candidates) {
			const token = candidate.token
			if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) continue
			const key = tokenDigest(token)
			const session = this.sessions.get(key)
			if (!session || session.localOnly !== candidate.localOnly) continue
			if (session.expiresAt <= now || session.method !== method) {
				this.sessions.delete(key)
				continue
			}
			return session.principal
		}
		return undefined
	}

	revoke(request: Request, allowLocalCookie: boolean = false): void {
		const secureToken = readCookie(request, SECURE_SESSION_COOKIE)
		if (secureToken) this.sessions.delete(tokenDigest(secureToken))
		if (allowLocalCookie) {
			const localToken = readCookie(request, LOCAL_SESSION_COOKIE)
			if (localToken) this.sessions.delete(tokenDigest(localToken))
		}
	}

	clear(): void {
		this.sessions.clear()
	}

	get size(): number {
		return this.sessions.size
	}

	private prune(now: number): void {
		for (const [key, session] of this.sessions) {
			if (session.expiresAt <= now) this.sessions.delete(key)
		}
	}
}

export function clearSessionCookie(secure: boolean = true): string {
	const name = secure ? SECURE_SESSION_COOKIE : LOCAL_SESSION_COOKIE
	return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`
}
