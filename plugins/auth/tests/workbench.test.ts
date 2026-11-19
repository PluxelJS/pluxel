import { createTestHost, type TestHost } from '@pluxel/test'
import { elysia } from '@pluxel/services/elysia'
import { type WorkbenchPrincipal } from '@pluxel/workbench'
import { describe, expect, it } from 'vitest'
import { AuthPlugin } from '../src/index.ts'
import { generateTotpForTesting } from '../src/totp.ts'
import { AuthWorkbench } from '../src/workbench.ts'

const PASSWORD = 'correct horse battery staple'
const LOCAL_RECOVERY = Object.freeze({ provider: 'local', subject: 'local' })

function openSetup(host: TestHost<true>, principal: WorkbenchPrincipal = LOCAL_RECOVERY) {
	return host.workbench.open({
		target: AuthPlugin.nodeAddress(),
		entry: AuthWorkbench.setup,
		principal,
		location: '/auth/setup',
	})
}

describe('Auth Workbench credential setup', () => {
	it('allows loopback recovery to provision the first password and refuses rotation', async () => {
		await using host = await createTestHost({ workbench: true, services: [elysia()] })
		await host.start(AuthPlugin.nodeAddress(), {
			initialConfig: { mode: { type: 'password' } },
		})
		const credentials = {
			username: 'Admin',
			password: PASSWORD,
			passwordConfirmation: PASSWORD,
		}
		using unauthorized = await openSetup(host, {
			provider: '@pluxel/plugin-auth',
			subject: 'local:admin',
		})
		await expect(unauthorized.api.setupPasswordDto(credentials)).resolves.toMatchObject({
			ok: false,
			code: 'forbidden',
		})

		using opened = await openSetup(host)
		await expect(opened.api.snapshotDto()).resolves.toEqual({
			mode: 'password',
			state: 'setup-required',
			reason: 'missing',
		})
		await expect(opened.api.setupPasswordDto(credentials)).resolves.toEqual({
			ok: true,
			snapshot: { mode: 'password', state: 'configured' },
		})
		await expect(opened.api.snapshotDto()).resolves.toEqual({
			mode: 'password',
			state: 'configured',
		})
		await expect(
			opened.api.setupPasswordDto({ ...credentials, username: 'Other' }),
		).resolves.toMatchObject({ ok: false, code: 'not_required' })
		opened[Symbol.dispose]()
		await expect(Promise.resolve().then((): unknown => opened.api.snapshotDto())).rejects.toThrow(
			/Auth setup View is closed|disposed/i,
		)
	})

	it('provisions password and TOTP as one credential', async () => {
		{
			await using host = await createTestHost({
				workbench: true,
				services: [elysia()],
			})

			await host.start(AuthPlugin.nodeAddress(), {
				initialConfig: { mode: { type: 'password-totp' } },
			})

			using opened = await openSetup(host)
			const enrollment = await opened.api.beginTotpDto({
				username: 'Admin',
				password: PASSWORD,
				passwordConfirmation: PASSWORD,
			})
			if (enrollment.ok === false) throw new Error(enrollment.message)
			await expect(
				opened.api.confirmTotpDto({
					enrollmentId: enrollment.enrollment.id,
					code: generateTotpForTesting(enrollment.enrollment.secret),
				}),
			).resolves.toEqual({
				ok: true,
				snapshot: { mode: 'password-totp', state: 'configured' },
			})
			await expect(opened.api.snapshotDto()).resolves.toEqual({
				mode: 'password-totp',
				state: 'configured',
			})
		}
	})

	it('provisions a confidential OIDC secret and skips it for public clients', async () => {
		{
			await using host = await createTestHost({
				workbench: true,
				services: [elysia()],
			})

			await host.start(AuthPlugin.nodeAddress(), {
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
			await expect(opened.api.snapshotDto()).resolves.toMatchObject({
				mode: 'oidc-confidential',
				state: 'setup-required',
			})
			await expect(opened.api.setupOidcSecretDto({ secret: 'client-secret' })).resolves.toEqual({
				ok: true,
				snapshot: { mode: 'oidc-confidential', state: 'configured' },
			})
			await expect(opened.api.snapshotDto()).resolves.toEqual({
				mode: 'oidc-confidential',
				state: 'configured',
			})
		}

		{
			await using host = await createTestHost({
				workbench: true,
				services: [elysia()],
			})

			await host.start(AuthPlugin.nodeAddress(), {
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
			await expect(opened.api.snapshotDto()).resolves.toEqual({
				mode: 'oidc-public',
				state: 'configured',
			})
			await expect(opened.api.setupOidcSecretDto({ secret: 'unused' })).resolves.toMatchObject({
				ok: false,
				code: 'not_required',
			})
		}
	})
})
