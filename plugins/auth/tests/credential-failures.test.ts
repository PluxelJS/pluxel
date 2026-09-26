import { afterEach, expect, it, vi } from 'vitest'
import { CredentialProvisioning } from '../src/credential-provisioning.ts'
import { hashPassword, PasswordHashBusyError, PasswordInputError } from '../src/password.ts'
import { RpcStub } from 'capnweb'
import { AuthSetupTarget } from '../src/auth-setup-target.ts'

vi.mock('../src/password.ts', { spy: true })
afterEach(() => vi.mocked(hashPassword).mockReset())

const input = {
	username: 'Admin',
	password: 'correct horse battery staple',
	passwordConfirmation: 'correct horse battery staple',
}

it.each([
	[new PasswordInputError('invalid'), 'invalid_input'],
	[new PasswordHashBusyError(), 'busy'],
] as const)('returns a recoverable setup failure for %s', async (error, code) => {
	vi.mocked(hashPassword).mockRejectedValueOnce(error)
	const saveAccount = vi.fn()
	const applyAccount = vi.fn()
	using provisioning = new CredentialProvisioning(
		{ type: 'password' },
		{ available: true, saveAccount, saveOidcSecret: vi.fn() },
		applyAccount,
		vi.fn(),
	)
	await expect(provisioning.setupPassword(input)).resolves.toMatchObject({ ok: false, code })
	expect(saveAccount).not.toHaveBeenCalled()
	expect(applyAccount).not.toHaveBeenCalled()
})

it('does not misclassify unexpected crypto failures as invalid input or expose their message', async () => {
	const defect = new Error('crypto failure containing private diagnostics')
	vi.mocked(hashPassword).mockRejectedValueOnce(defect)
	const saveAccount = vi.fn()
	const applyAccount = vi.fn()
	using provisioning = new CredentialProvisioning(
		{ type: 'password' },
		{ available: true, saveAccount, saveOidcSecret: vi.fn() },
		applyAccount,
		vi.fn(),
	)
	await expect(provisioning.setupPassword(input)).rejects.toMatchObject({
		message: 'Password hashing failed.',
		cause: defect,
	})
	expect(saveAccount).not.toHaveBeenCalled()
	expect(applyAccount).not.toHaveBeenCalled()
})

it.each(['password', 'password-totp'] as const)(
	'keeps diagnostic causes out of %s setup RPC failures',
	async (mode) => {
		vi.mocked(hashPassword).mockRejectedValueOnce(new Error('private crypto diagnostic'))
		const provisioning = new CredentialProvisioning(
			{ type: mode },
			{ available: true, saveAccount: vi.fn(), saveOidcSecret: vi.fn() },
			vi.fn(),
			vi.fn(),
		)
		using api = new RpcStub(
			new AuthSetupTarget({
				authorized: true,
				signal: new AbortController().signal,
				provisioning,
				snapshot: () => ({ mode, state: 'setup-required', reason: 'missing' }),
				mutate: (operation) => operation(),
			}),
		)
		const operation = mode === 'password' ? api.setupPasswordDto(input) : api.beginTotpDto(input)
		const error = await operation.then(
			(): undefined => undefined,
			(reason: Error) => reason,
		)
		expect(error?.message).toBe('Credential setup failed.')
		expect(error?.cause).toBeUndefined()
		expect(error?.stack).not.toContain('private crypto diagnostic')
	},
)
