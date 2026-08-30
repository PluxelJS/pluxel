import type { ManagementAuthenticationProviderStep } from '@pluxel/runtime'
import { describe, expect, it, vi } from 'vitest'
import { PasswordAuthenticationSession } from '../src/challenge.ts'

function authenticated(): ManagementAuthenticationProviderStep {
	return {
		kind: 'authenticated',
		principal: { subject: 'local:admin', displayName: 'Admin' },
		cookieCommit: { ticket: 't'.repeat(43), expiresAt: Date.now() + 60_000 },
	}
}

describe("Cap'n Web password challenge", () => {
	it('uses password then TOTP on one disposable session', async () => {
		const verifyPassword = vi.fn(async () => 'accepted' as const)
		const verifyTotp = vi.fn(async () => 'accepted' as const)
		const session = new PasswordAuthenticationSession({
			label: 'Admin',
			requireTotp: true,
			verifyPassword,
			verifyTotp,
			authenticated,
		})

		expect(session.state()).toEqual({
			kind: 'challenge',
			challenge: { kind: 'password', label: 'Admin' },
		})
		await expect(session.submit({ password: 'correct horse battery staple' })).resolves.toEqual({
			kind: 'challenge',
			challenge: { kind: 'totp', digits: 6 },
		})
		await expect(session.submit({ code: '123456' })).resolves.toMatchObject({
			kind: 'authenticated',
			principal: { subject: 'local:admin' },
			cookieCommit: { ticket: 't'.repeat(43) },
		})
		expect(verifyPassword).toHaveBeenCalledOnce()
		expect(verifyTotp).toHaveBeenCalledOnce()

		session[Symbol.dispose]()
		session[Symbol.dispose]()
		expect(session.state()).toEqual({ kind: 'failed', code: 'authentication_expired' })
	})

	it('rejects ambiguous payloads without invoking a verifier', async () => {
		const verifyPassword = vi.fn(async () => 'accepted' as const)
		const session = new PasswordAuthenticationSession({
			requireTotp: false,
			verifyPassword,
			verifyTotp: vi.fn(async () => 'accepted' as const),
			authenticated,
		})

		await expect(session.submit({ password: 'secret', extra: true })).resolves.toEqual({
			kind: 'failed',
			code: 'authentication_failed',
		})
		expect(verifyPassword).not.toHaveBeenCalled()
		await expect(session.submit({ password: 'secret' })).resolves.toEqual({
			kind: 'failed',
			code: 'authentication_expired',
		})
	})

	it('maps fixed admission outcomes to stable failure codes', async () => {
		const session = new PasswordAuthenticationSession({
			requireTotp: false,
			verifyPassword: vi.fn(async () => 'limited' as const),
			verifyTotp: vi.fn(async () => 'rejected' as const),
			authenticated,
		})
		await expect(session.submit({ password: 'secret' })).resolves.toEqual({
			kind: 'failed',
			code: 'attempt_limited',
		})
	})

	it('cannot issue authority after disposal while verification is pending', async () => {
		let resolveVerification!: (result: 'accepted') => void
		const verifyPassword = vi.fn(
			() =>
				new Promise<'accepted'>((resolve) => {
					resolveVerification = resolve
				}),
		)
		const issueAuthority = vi.fn(authenticated)
		const session = new PasswordAuthenticationSession({
			requireTotp: false,
			verifyPassword,
			verifyTotp: vi.fn(async () => 'rejected' as const),
			authenticated: issueAuthority,
		})

		const pending = session.submit({ password: 'secret' })
		session[Symbol.dispose]()
		resolveVerification('accepted')
		await expect(pending).resolves.toEqual({
			kind: 'failed',
			code: 'authentication_expired',
		})
		expect(issueAuthority).not.toHaveBeenCalled()
	})

	it('retains only the narrow logout action after authentication succeeds', async () => {
		const logout = vi.fn(() => ({ ticket: 'l'.repeat(43), expiresAt: Date.now() + 60_000 }))
		const session = new PasswordAuthenticationSession({
			requireTotp: false,
			verifyPassword: vi.fn(async () => 'accepted' as const),
			verifyTotp: vi.fn(async () => 'rejected' as const),
			authenticated,
			logout,
		})
		await session.submit({ password: 'secret' })
		expect(session.logout()).toMatchObject({ ticket: 'l'.repeat(43) })
		expect(logout).toHaveBeenCalledOnce()
		session[Symbol.dispose]()
		expect(session.logout()).toBeUndefined()
	})
})
