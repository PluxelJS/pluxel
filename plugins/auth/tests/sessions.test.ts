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
})
