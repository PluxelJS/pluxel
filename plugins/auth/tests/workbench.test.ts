import { createRuntimeTestHost, type RuntimeTestHost } from '@pluxel/runtime/test'
import type { WorkbenchPrincipal } from '@pluxel/runtime/workbench'
import { describe, expect, it } from 'vitest'
import { AuthPlugin } from '../src/index.ts'
import { generateTotpForTesting } from '../src/totp.ts'
import { AuthWorkbench } from '../src/workbench.ts'

const PASSWORD = 'correct horse battery staple'
const LOCAL_RECOVERY = Object.freeze({ provider: 'local', subject: 'local' })

function openSetup(host: RuntimeTestHost, principal: WorkbenchPrincipal = LOCAL_RECOVERY) {
	return host.workbench.open({
		target: AuthPlugin,
		entry: AuthWorkbench.setup,
		principal,
		location: '/auth/setup',
	})
}

describe('Auth Workbench credential setup', () => {
	it('provisions the first password and refuses credential rotation', async () => {
		{
			await using host = createRuntimeTestHost({ workbench: { enabled: true }, vault: {} })

			await host.start(AuthPlugin, {
				initialConfig: { mode: { type: 'password' } },
			})

			using opened = await openSetup(host)
			await expect(opened.api.snapshot()).resolves.toEqual({
				mode: 'password',
				state: 'setup-required',
				reason: 'missing',
			})
			await expect(
				opened.api.setupPassword({
					username: 'Admin',
					password: PASSWORD,
					passwordConfirmation: PASSWORD,
				}),
			).resolves.toEqual({
				ok: true,
				snapshot: { mode: 'password', state: 'configured' },
			})
			await expect(opened.api.snapshot()).resolves.toEqual({
				mode: 'password',
				state: 'configured',
			})
			await expect(
				opened.api.setupPassword({
					username: 'Other',
					password: PASSWORD,
					passwordConfirmation: PASSWORD,
				}),
			).resolves.toMatchObject({ ok: false, code: 'not_required' })
			opened[Symbol.dispose]()
			await expect(Promise.resolve().then((): unknown => opened.api.snapshot())).rejects.toThrow(
				/Auth setup View is closed|disposed/i,
			)
		}
	})

	it('allows mutations only for the loopback recovery principal', async () => {
		{
			await using host = createRuntimeTestHost({ workbench: { enabled: true }, vault: {} })

			await host.start(AuthPlugin, {
				initialConfig: { mode: { type: 'password' } },
			})

			using opened = await openSetup(host, {
				provider: '@pluxel/auth',
				subject: 'local:admin',
			})
			await expect(
				opened.api.setupPassword({
					username: 'Admin',
					password: PASSWORD,
					passwordConfirmation: PASSWORD,
				}),
			).resolves.toMatchObject({ ok: false, code: 'forbidden' })
		}
	})

	it('provisions password and TOTP as one credential', async () => {
		{
			await using host = createRuntimeTestHost({ workbench: { enabled: true }, vault: {} })

			await host.start(AuthPlugin, {
				initialConfig: { mode: { type: 'password-totp' } },
			})

			using opened = await openSetup(host)
			const enrollment = await opened.api.beginTotp({
				username: 'Admin',
				password: PASSWORD,
				passwordConfirmation: PASSWORD,
			})
			if (enrollment.ok === false) throw new Error(enrollment.message)
			await expect(
				opened.api.confirmTotp({
					enrollmentId: enrollment.enrollment.id,
					code: generateTotpForTesting(enrollment.enrollment.secret),
				}),
			).resolves.toEqual({
				ok: true,
				snapshot: { mode: 'password-totp', state: 'configured' },
			})
			await expect(opened.api.snapshot()).resolves.toEqual({
				mode: 'password-totp',
				state: 'configured',
			})
		}
	})

	it('provisions a confidential OIDC secret and skips it for public clients', async () => {
		{
			await using host = createRuntimeTestHost({ workbench: { enabled: true }, vault: {} })

			await host.start(AuthPlugin, {
				initialConfig: {
					mode: {
						type: 'oidc',
						issuer: 'https://issuer.example',
						clientId: 'client',
						publicOrigin: 'https://admin.example',
						clientKind: 'confidential',
					},
				},
			})

			using opened = await openSetup(host)
			await expect(opened.api.snapshot()).resolves.toMatchObject({
				mode: 'oidc-confidential',
				state: 'setup-required',
			})
			await expect(opened.api.setupOidcSecret({ secret: 'client-secret' })).resolves.toEqual({
				ok: true,
				snapshot: { mode: 'oidc-confidential', state: 'configured' },
			})
			await expect(opened.api.snapshot()).resolves.toEqual({
				mode: 'oidc-confidential',
				state: 'configured',
			})
		}

		{
			await using host = createRuntimeTestHost({ workbench: { enabled: true } })

			await host.start(AuthPlugin, {
				initialConfig: {
					mode: {
						type: 'oidc',
						issuer: 'https://issuer.example',
						clientId: 'client',
						publicOrigin: 'https://admin.example',
						clientKind: 'public',
					},
				},
			})

			using opened = await openSetup(host)
			await expect(opened.api.snapshot()).resolves.toEqual({
				mode: 'oidc-public',
				state: 'configured',
			})
			await expect(opened.api.setupOidcSecret({ secret: 'unused' })).resolves.toMatchObject({
				ok: false,
				code: 'not_required',
			})
		}
	})
})
