import '@pluxel/test/setup'

// Ensure @pluxel/hmr services (HonoService/AuthGuardService/ExtService) are registered.
import '../../src/services'

import { createHost, type Host } from '@pluxel/test'
import { afterEach, describe, expect, it } from 'vitest'
import { AuthGuardTestPlugin } from '../fixtures/plugins/AuthGuardTestPlugin'

function req(url: string, init?: RequestInit) {
	return new Request(url, init)
}

function pickCookie(setCookie: string | null): string {
	if (!setCookie) throw new Error('missing Set-Cookie header')
	return setCookie.split(';')[0]!.trim()
}

describe('AuthGuard end-to-end (HonoService)', () => {
	let host: Host | null = null

	afterEach(async () => {
		if (!host) return
		await host.dispose()
		host = null
	})

	it('guards /__pluxel/hmr and HTML navigation; /auth verify unblocks; unload removes guard', async () => {
		host = createHost()

		// Force service construction.
		void host.ctx.honoService
		void host.ctx.authGuard

		// Baseline: no guard -> internal API is accessible without cookie.
		{
			const res = await host.ctx.honoService.fetch(req('http://local/__pluxel/hmr'))
			expect(res.status).toBe(200)
			expect(await res.text()).toContain('Pluxel HMR RPC ready')
		}

		// Start the test plugin which registers a guard and mounts /auth + /auth/verify.
		host.add(AuthGuardTestPlugin)
		host.cfg('AuthGuardTest').enable()
		await host.commit()

		expect(host.ctx.authGuard.isActive()).toBe(true)

		// internal API is blocked without cookie (marker header + redirectPath).
		{
			const res = await host.ctx.honoService.fetch(
				req('http://local/__pluxel/hmr', {
					headers: { accept: 'application/json' },
				}),
			)
			expect(res.status).toBe(401)
			expect(res.headers.get('X-Pluxel-Auth-Blocked')).toBe('1')
			expect(res.headers.get('X-Pluxel-Redirect-Path')).toBe('/auth')

			const payload = (await res.json()) as any
			expect(payload?.allow).toBe(false)
			expect(payload?.redirectPath).toBe('/auth')
		}

		// HTML navigation is redirected to /auth.
		{
			const res = await host.ctx.honoService.fetch(
				req('http://local/', {
					headers: {
						accept: 'text/html',
						'sec-fetch-mode': 'navigate',
						'sec-fetch-dest': 'document',
					},
				}),
			)
			expect(res.status).toBe(302)
			expect(res.headers.get('location')).toBe('/auth')
		}

		// /auth page exists (plugin route, not guarded).
		{
			const res = await host.ctx.honoService.fetch(
				req('http://local/auth', { headers: { accept: 'text/html' } }),
			)
			expect(res.status).toBe(200)
			expect(await res.text()).toContain('id="verify"')
		}

		// "Click verify": POST /auth/verify gives a cookie that allows internal API.
		const cookie = await (async () => {
			const res = await host!.ctx.honoService.fetch(
				req('http://local/auth/verify', { method: 'POST' }),
			)
			expect(res.status).toBe(200)
			return pickCookie(res.headers.get('set-cookie'))
		})()

		{
			const res = await host.ctx.honoService.fetch(
				req('http://local/__pluxel/hmr', {
					headers: { cookie },
				}),
			)
			expect(res.status).toBe(200)
		}

		// Unload plugin -> guard is removed -> internal API is accessible again without cookie.
		host.remove(AuthGuardTestPlugin)
		await host.commit()

		expect(host.ctx.authGuard.isActive()).toBe(false)

		{
			const res = await host.ctx.honoService.fetch(req('http://local/__pluxel/hmr'))
			expect(res.status).toBe(200)
		}
	})
})
