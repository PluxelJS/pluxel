import { describe, expect, it, vi } from 'vitest'
import { CredentialProvisioning } from '../src/credential-provisioning.ts'
import { generateTotpForTesting } from '../src/totp.ts'

const PASSWORD = 'correct horse battery staple'

describe('transport-free credential provisioning', () => {
	it('persists a password account without exposing an HTTP setup transport', async () => {
		const saveAccount = vi.fn(async () => undefined)
		const applyAccount = vi.fn()
		const provisioning = new CredentialProvisioning(
			{ type: 'password' },
			{
				available: true,
				saveAccount,
				saveOidcSecret: vi.fn(async () => undefined),
			},
			applyAccount,
			vi.fn(),
		)

		await expect(
			provisioning.setupPassword({
				username: 'Admin',
				password: PASSWORD,
				passwordConfirmation: PASSWORD,
			}),
		).resolves.toEqual({ ok: true })
		expect(saveAccount).toHaveBeenCalledOnce()
		expect(applyAccount).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'local-account',
				username: 'Admin',
				normalizedUsername: 'admin',
			}),
		)
		provisioning[Symbol.dispose]()
		await expect(
			provisioning.setupPassword({
				username: 'Admin',
				password: PASSWORD,
				passwordConfirmation: PASSWORD,
			}),
		).resolves.toEqual({
			ok: false,
			code: 'not_required',
			message: 'Password setup is not available.',
		})
	})

	it('persists a confidential OIDC secret only in the matching mode', async () => {
		const saveOidcSecret = vi.fn(async () => undefined)
		const applyOidcSecret = vi.fn()
		const provisioning = new CredentialProvisioning(
			{
				type: 'oidc',
				issuer: 'https://issuer.example',
				clientId: 'client',
				publicOrigin: 'https://admin.example',
				clientKind: 'confidential',
				scopes: ['openid'],
			},
			{
				available: true,
				saveAccount: vi.fn(async () => undefined),
				saveOidcSecret,
			},
			vi.fn(),
			applyOidcSecret,
		)

		await expect(provisioning.setupOidcSecret({ secret: 'client-secret' })).resolves.toEqual({
			ok: true,
		})
		expect(saveOidcSecret).toHaveBeenCalledWith('client-secret')
		expect(applyOidcSecret).toHaveBeenCalledWith('client-secret')
	})

	it('persists password and TOTP together only after confirmation', async () => {
		const saveAccount = vi.fn(async () => undefined)
		const applyAccount = vi.fn()
		const provisioning = new CredentialProvisioning(
			{ type: 'password-totp' },
			{
				available: true,
				saveAccount,
				saveOidcSecret: vi.fn(async () => undefined),
			},
			applyAccount,
			vi.fn(),
		)

		const started = await provisioning.beginTotp({
			username: 'Admin',
			password: PASSWORD,
			passwordConfirmation: PASSWORD,
		})
		expect(started.ok).toBe(true)
		expect(saveAccount).not.toHaveBeenCalled()
		if (started.ok === false) throw new Error(started.message)

		await expect(
			provisioning.confirmTotp({
				enrollmentId: started.enrollment.id,
				code: generateTotpForTesting(started.enrollment.secret),
			}),
		).resolves.toEqual({ ok: true })
		expect(saveAccount).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'local-account',
				totp: expect.objectContaining({ secret: started.enrollment.secret }),
			}),
		)
		expect(applyAccount).toHaveBeenCalledOnce()
	})

	it('rejects malformed transport input before hashing or storage', async () => {
		const saveAccount = vi.fn(async () => undefined)
		const provisioning = new CredentialProvisioning(
			{ type: 'password' },
			{
				available: true,
				saveAccount,
				saveOidcSecret: vi.fn(async () => undefined),
			},
			vi.fn(),
			vi.fn(),
		)

		await expect(
			provisioning.setupPassword({
				username: 'Admin',
				password: PASSWORD,
				passwordConfirmation: PASSWORD,
				extra: true,
			} as never),
		).resolves.toMatchObject({ ok: false, code: 'invalid_input' })
		expect(saveAccount).not.toHaveBeenCalled()
	})

	it('reports persistence failure without applying a credential', async () => {
		const applyAccount = vi.fn()
		const provisioning = new CredentialProvisioning(
			{ type: 'password' },
			{
				available: true,
				saveAccount: vi.fn(async () => {
					throw new Error('disk unavailable')
				}),
				saveOidcSecret: vi.fn(async () => undefined),
			},
			applyAccount,
			vi.fn(),
		)

		await expect(
			provisioning.setupPassword({
				username: 'Admin',
				password: PASSWORD,
				passwordConfirmation: PASSWORD,
			}),
		).resolves.toMatchObject({ ok: false, code: 'storage_failed' })
		expect(applyAccount).not.toHaveBeenCalled()
	})

	it('does not require a secret for a public OIDC client', async () => {
		const saveOidcSecret = vi.fn(async () => undefined)
		const provisioning = new CredentialProvisioning(
			{
				type: 'oidc',
				issuer: 'https://issuer.example',
				clientId: 'client',
				publicOrigin: 'https://admin.example',
				clientKind: 'public',
				scopes: ['openid'],
			},
			{
				available: false,
				saveAccount: vi.fn(async () => undefined),
				saveOidcSecret,
			},
			vi.fn(),
			vi.fn(),
		)

		await expect(provisioning.setupOidcSecret({ secret: 'unused' })).resolves.toMatchObject({
			ok: false,
			code: 'not_required',
		})
		expect(saveOidcSecret).not.toHaveBeenCalled()
	})
})
