import { requireWorkbench } from '@pluxel/runtime/internal'
import { pluginNodeAddressOf, createRuntimeHost, type RuntimeHost } from '@pluxel/runtime/test'
import type { WorkbenchPrincipal } from '@pluxel/runtime/workbench'
import { describe, expect, it } from 'vitest'
import { AuthPlugin } from '../src/index.ts'
import { generateTotpForTesting } from '../src/totp.ts'
import type { AuthSetupApi } from '../src/workbench.ts'

const PASSWORD = 'correct horse battery staple'
const LOCAL_RECOVERY = Object.freeze({ provider: 'local', subject: 'local' })

async function openSetup(host: RuntimeHost, principal: WorkbenchPrincipal = LOCAL_RECOVERY) {
	const backend = requireWorkbench(host.ctx)
	const target = pluginNodeAddressOf(AuthPlugin)
	const layout = backend.registry.getLayout(target)
	const entry = layout.entries.find(
		(candidate) => candidate.descriptor.kind === 'view' && candidate.descriptor.key === 'setup',
	)
	if (!entry) throw new Error('AuthPlugin published no setup View')
	const session = backend.createSession(principal, () => {})
	const opened = await session.target.openEntry({
		layoutRevision: layout.revision,
		target,
		descriptor: entry.descriptor,
		location: '/auth/setup',
	})
	if (!opened.ok || opened.value.kind !== 'local') {
		session.dispose()
		throw new Error('Auth setup View failed to open')
	}
	return Object.freeze({ api: opened.value.api as AuthSetupApi, session })
}

describe('Auth Workbench credential setup', () => {
	it('provisions the first password and refuses credential rotation', async () => {
		{
			await using host = createRuntimeHost({ workbench: { enabled: true }, vault: {} })

			host.add(AuthPlugin)
			host.cfg(AuthPlugin).set({ mode: { type: 'password' } })
			host.start(AuthPlugin)
			await host.commit()

			const opened = await openSetup(host)
			expect(opened.api.snapshot()).toEqual({
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
			await expect(host.ctx.adminAccess?.describe()).resolves.toMatchObject({
				provider: { ready: true },
			})
			await expect(
				opened.api.setupPassword({
					username: 'Other',
					password: PASSWORD,
					passwordConfirmation: PASSWORD,
				}),
			).resolves.toMatchObject({ ok: false, code: 'not_required' })
			opened.session.dispose()
			expect(() => opened.api.snapshot()).toThrow('Auth setup View is closed')
		}
	})

	it('allows mutations only for the loopback recovery principal', async () => {
		{
			await using host = createRuntimeHost({ workbench: { enabled: true }, vault: {} })

			host.add(AuthPlugin)
			host.cfg(AuthPlugin).set({ mode: { type: 'password' } })
			host.start(AuthPlugin)
			await host.commit()

			const opened = await openSetup(host, {
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
			opened.session.dispose()
		}
	})

	it('provisions password and TOTP as one credential', async () => {
		{
			await using host = createRuntimeHost({ workbench: { enabled: true }, vault: {} })

			host.add(AuthPlugin)
			host.cfg(AuthPlugin).set({ mode: { type: 'password-totp' } })
			host.start(AuthPlugin)
			await host.commit()

			const opened = await openSetup(host)
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
			await expect(host.ctx.adminAccess?.describe()).resolves.toMatchObject({
				provider: { ready: true },
			})
			opened.session.dispose()
		}
	})

	it('provisions a confidential OIDC secret and skips it for public clients', async () => {
		{
			await using host = createRuntimeHost({ workbench: { enabled: true }, vault: {} })

			host.add(AuthPlugin)
			host.cfg(AuthPlugin).set({
				mode: {
					type: 'oidc',
					issuer: 'https://issuer.example',
					clientId: 'client',
					publicOrigin: 'https://admin.example',
					clientKind: 'confidential',
				},
			})
			host.start(AuthPlugin)
			await host.commit()

			const opened = await openSetup(host)
			expect(opened.api.snapshot()).toMatchObject({
				mode: 'oidc-confidential',
				state: 'setup-required',
			})
			await expect(opened.api.setupOidcSecret({ secret: 'client-secret' })).resolves.toEqual({
				ok: true,
				snapshot: { mode: 'oidc-confidential', state: 'configured' },
			})
			await expect(host.ctx.adminAccess?.describe()).resolves.toMatchObject({
				provider: { ready: true },
			})
			opened.session.dispose()
		}

		{
			await using host = createRuntimeHost({ workbench: { enabled: true } })

			host.add(AuthPlugin)
			host.cfg(AuthPlugin).set({
				mode: {
					type: 'oidc',
					issuer: 'https://issuer.example',
					clientId: 'client',
					publicOrigin: 'https://admin.example',
					clientKind: 'public',
				},
			})
			host.start(AuthPlugin)
			await host.commit()

			const opened = await openSetup(host)
			expect(opened.api.snapshot()).toEqual({
				mode: 'oidc-public',
				state: 'configured',
			})
			await expect(opened.api.setupOidcSecret({ secret: 'unused' })).resolves.toMatchObject({
				ok: false,
				code: 'not_required',
			})
			opened.session.dispose()
		}
	})
})
