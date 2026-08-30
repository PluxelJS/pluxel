import { describe, expect, it } from 'vitest'
import { SessionStore } from '../src/sessions.ts'

describe('generation sessions', () => {
	it('uses an opaque secure cookie and revokes it without storing the raw token as a key', () => {
		const sessions = new SessionStore()
		const cookie = sessions.create(
			{ subject: 'local:admin', displayName: 'admin' },
			'password',
			true,
			10,
		)
		expect(cookie).toContain('HttpOnly')
		expect(cookie).toContain('Secure')
		expect(cookie).toContain('SameSite=Lax')
		const pair = cookie.split(';', 1)[0]!
		const request = new Request('https://host.example/', { headers: { cookie: pair } })
		expect(sessions.read(request, 'password', false, 11)).toEqual({
			subject: 'local:admin',
			displayName: 'admin',
		})
		sessions.revoke(request)
		expect(sessions.read(request, 'password', false, 12)).toBeUndefined()
	})

	it('uses a host-only local cookie over a loopback HTTP tunnel and never accepts it remotely', () => {
		const sessions = new SessionStore()
		const cookie = sessions.create({ subject: 'local:admin' }, 'password', false)
		expect(cookie).toContain('pluxel_admin_local_session=')
		expect(cookie).not.toContain('Secure')
		const pair = cookie.split(';', 1)[0]!
		const request = new Request('http://127.0.0.1/', { headers: { cookie: pair } })
		expect(sessions.read(request, 'password', false)).toBeUndefined()
		expect(sessions.read(request, 'password', true)).toEqual({ subject: 'local:admin' })
	})

	it('binds sessions to one configured method and clears a generation atomically', () => {
		const sessions = new SessionStore()
		const cookie = sessions.create({ subject: 'issuer\0subject' }, 'oidc')
		const request = new Request('https://host.example/', {
			headers: { cookie: cookie.split(';', 1)[0]! },
		})
		expect(sessions.read(request, 'password')).toBeUndefined()
		expect(sessions.size).toBe(0)
		const next = sessions.create({ subject: 'local:admin' }, 'password')
		expect(sessions.size).toBe(1)
		sessions.clear()
		expect(
			sessions.read(
				new Request('https://host.example/', {
					headers: { cookie: next.split(';', 1)[0]! },
				}),
				'password',
			),
		).toBeUndefined()
	})

	it('commits a session cookie with a short-lived single-use ticket', () => {
		const sessions = new SessionStore()
		const commit = sessions.issueCommit({ subject: 'local:admin' }, 'password', true, 10)
		expect(commit.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/)
		expect(commit.expiresAt).toBe(60_010)
		const cookie = sessions.commit(commit.ticket, true, 11)
		expect(cookie).toContain('__Host-pluxel_admin_session=')
		expect(sessions.commit(commit.ticket, true, 12)).toBeUndefined()
		const request = new Request('https://host.example/', {
			headers: { cookie: cookie!.split(';', 1)[0]! },
		})
		expect(sessions.read(request, 'password', false, 13)).toEqual({ subject: 'local:admin' })
	})

	it('expires an uncommitted ticket and its unreachable session together', () => {
		const sessions = new SessionStore()
		const commit = sessions.issueCommit({ subject: 'local:admin' }, 'password', true, 10)
		expect(sessions.size).toBe(1)
		expect(sessions.commit(commit.ticket, true, commit.expiresAt)).toBeUndefined()
		expect(sessions.size).toBe(0)
	})

	it('revokes an authenticated cookie before issuing its single-use clear commit', () => {
		const sessions = new SessionStore()
		const cookie = sessions.create({ subject: 'local:admin' }, 'password', true, 10)
		const request = new Request('https://host.example/', {
			headers: { cookie: cookie.split(';', 1)[0]! },
		})
		const logout = sessions.issueLogout(request, false, 11)
		expect(logout).toBeDefined()
		expect(sessions.read(request, 'password', false, 12)).toBeUndefined()
		expect(sessions.commit(logout!.ticket, true, 13)).toContain('Max-Age=0; Secure')
		expect(sessions.commit(logout!.ticket, true, 14)).toBeUndefined()
	})

	it('revokes a bound session even after its login ticket was committed', () => {
		const sessions = new SessionStore()
		const issued = sessions.issueBoundCommit({ subject: 'local:admin' }, 'password', true, 10)
		const cookie = sessions.commit(issued.commit.ticket, true, 11)
		const request = new Request('https://host.example/', {
			headers: { cookie: cookie!.split(';', 1)[0]! },
		})
		expect(sessions.read(request, 'password', false, 12)).toBeDefined()
		issued.revoke()
		expect(sessions.read(request, 'password', false, 13)).toBeUndefined()
	})
})
