import { createHash, randomBytes } from 'node:crypto'
import type { ManagementAccessMethod, ManagementAccessPrincipal } from '@pluxel/runtime'

type AuthMethod = ManagementAccessMethod
type AuthPrincipal = ManagementAccessPrincipal

const SECURE_SESSION_COOKIE = '__Host-pluxel_admin_session'
const LOCAL_SESSION_COOKIE = 'pluxel_admin_local_session'
const SESSION_TTL_MS = 12 * 60 * 60 * 1_000
const MAX_SESSIONS = 2_048
const COMMIT_TTL_MS = 60_000
const MAX_PENDING_COMMITS = 256
const MAX_COOKIE_HEADER_BYTES = 8_192

type Session = Readonly<{
	principal: AuthPrincipal
	method: AuthMethod
	localOnly: boolean
	expiresAt: number
}>

type PendingCommit = Readonly<{
	cookie: string
	sessionKey?: string
	secure: boolean
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
	private readonly pendingCommits = new Map<string, PendingCommit>()

	create(
		principal: AuthPrincipal,
		method: AuthMethod,
		secure: boolean = true,
		now: number = Date.now(),
	): string {
		this.prune(now)
		this.reserveSessionSlot()
		const { cookie } = this.createSession(principal, method, secure, now)
		return cookie
	}

	issueCommit(
		principal: AuthPrincipal,
		method: AuthMethod,
		secure: boolean,
		now: number = Date.now(),
	): Readonly<{ ticket: string; expiresAt: number }> {
		return this.issueBoundCommit(principal, method, secure, now).commit
	}

	issueBoundCommit(
		principal: AuthPrincipal,
		method: AuthMethod,
		secure: boolean,
		now: number = Date.now(),
	): Readonly<{
		commit: Readonly<{ ticket: string; expiresAt: number }>
		revoke(): void
	}> {
		this.prune(now)
		this.reserveSessionSlot()
		const { cookie, sessionKey } = this.createSession(principal, method, secure, now)
		const commit = this.issueCookieCommit(cookie, secure, now, sessionKey)
		return Object.freeze({
			commit,
			revoke: () => {
				this.revokeCommit(commit.ticket)
				this.sessions.delete(sessionKey)
			},
		})
	}

	commit(ticket: string, secure: boolean, now: number = Date.now()): string | undefined {
		this.prune(now)
		if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) return undefined
		const key = tokenDigest(ticket)
		const pending = this.pendingCommits.get(key)
		if (!pending || pending.secure !== secure || pending.expiresAt <= now) return undefined
		this.pendingCommits.delete(key)
		return pending.cookie
	}

	revokeCommit(ticket: string): void {
		if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) return
		this.deleteCommit(tokenDigest(ticket))
	}

	issueLogout(
		request: Request,
		allowLocalCookie: boolean = false,
		now: number = Date.now(),
	): Readonly<{ ticket: string; expiresAt: number }> | undefined {
		this.prune(now)
		const candidates: readonly Readonly<{
			name: string
			token?: string
			localOnly: boolean
			secure: boolean
		}>[] = [
			{
				name: SECURE_SESSION_COOKIE,
				token: readCookie(request, SECURE_SESSION_COOKIE),
				localOnly: false,
				secure: true,
			},
			...(allowLocalCookie
				? [
						{
							name: LOCAL_SESSION_COOKIE,
							token: readCookie(request, LOCAL_SESSION_COOKIE),
							localOnly: true,
							secure: false,
						},
					]
				: []),
		]
		for (const candidate of candidates) {
			const token = candidate.token
			if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) continue
			const sessionKey = tokenDigest(token)
			const session = this.sessions.get(sessionKey)
			if (!session || session.localOnly !== candidate.localOnly) continue
			this.sessions.delete(sessionKey)
			return this.issueCookieCommit(
				`${candidate.name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${candidate.secure ? '; Secure' : ''}`,
				candidate.secure,
				now,
			)
		}
		return undefined
	}

	issueClearCookie(
		secure: boolean,
		now: number = Date.now(),
	): Readonly<{ ticket: string; expiresAt: number }> {
		const name = secure ? SECURE_SESSION_COOKIE : LOCAL_SESSION_COOKIE
		return this.issueCookieCommit(
			`${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`,
			secure,
			now,
		)
	}

	private createSession(
		principal: AuthPrincipal,
		method: AuthMethod,
		secure: boolean,
		now: number,
	): Readonly<{ cookie: string; sessionKey: string }> {
		const token = randomBytes(32).toString('base64url')
		const sessionKey = tokenDigest(token)
		this.sessions.set(
			sessionKey,
			Object.freeze({ principal, method, localOnly: !secure, expiresAt: now + SESSION_TTL_MS }),
		)
		const name = secure ? SECURE_SESSION_COOKIE : LOCAL_SESSION_COOKIE
		return Object.freeze({
			cookie: `${name}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1_000)}${secure ? '; Secure' : ''}`,
			sessionKey,
		})
	}

	read(
		request: Request,
		method: AuthMethod,
		allowLocalCookie: boolean = false,
		now: number = Date.now(),
	): AuthPrincipal | undefined {
		this.prune(now)
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
		this.pendingCommits.clear()
	}

	get size(): number {
		return this.sessions.size
	}

	private prune(now: number): void {
		for (const [key, session] of this.sessions) {
			if (session.expiresAt <= now) this.sessions.delete(key)
		}
		for (const [key, pending] of this.pendingCommits) {
			if (pending.expiresAt <= now) this.deleteCommit(key)
		}
	}

	private deleteCommit(key: string): void {
		const pending = this.pendingCommits.get(key)
		if (!pending) return
		this.pendingCommits.delete(key)
		if (pending.sessionKey) this.sessions.delete(pending.sessionKey)
	}

	private issueCookieCommit(
		cookie: string,
		secure: boolean,
		now: number,
		sessionKey?: string,
	): Readonly<{ ticket: string; expiresAt: number }> {
		while (this.pendingCommits.size >= MAX_PENDING_COMMITS) {
			const oldest = this.pendingCommits.keys().next().value as string | undefined
			if (!oldest) break
			this.deleteCommit(oldest)
		}
		const ticket = randomBytes(32).toString('base64url')
		const expiresAt = now + COMMIT_TTL_MS
		this.pendingCommits.set(
			tokenDigest(ticket),
			Object.freeze({ cookie, secure, expiresAt, ...(sessionKey ? { sessionKey } : {}) }),
		)
		return Object.freeze({ ticket, expiresAt })
	}

	private reserveSessionSlot(): void {
		while (this.sessions.size >= MAX_SESSIONS) {
			const oldest = this.sessions.keys().next().value as string | undefined
			if (!oldest) break
			this.sessions.delete(oldest)
			for (const [key, pending] of this.pendingCommits) {
				if (pending.sessionKey === oldest) this.pendingCommits.delete(key)
			}
		}
	}
}
