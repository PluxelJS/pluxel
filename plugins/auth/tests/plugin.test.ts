import { withRuntimeHost } from '@pluxel/runtime/test'
import { describe, expect, it } from 'vitest'
import { AuthPlugin } from '../src/index.ts'

describe('AuthPlugin lifecycle', () => {
	it('runs in setup-required state and revokes its generation on stop', async () => {
		await withRuntimeHost(
			async (host) => {
				host.add(AuthPlugin)
				host.cfg(AuthPlugin).set({ mode: { type: 'password' } })
				host.start(AuthPlugin)
				await host.commit()
				expect(await host.ctx.adminAccess?.describe()).toEqual({
					policy: 'provider-or-local-recovery',
					provider: {
						id: '@pluxel/auth',
						label: 'Pluxel Authentication',
						method: 'password',
						ready: false,
					},
				})
				host.stop(AuthPlugin)
				await host.commit()
				expect(await host.ctx.adminAccess?.describe()).toEqual({
					policy: 'provider-or-local-recovery',
					provider: null,
				})
			},
			{ vault: {}, management: {}, workbench: false },
		)
	})

	it('runs public OIDC without Vault', async () => {
		await withRuntimeHost(
			async (host) => {
				host.add(AuthPlugin)
				host.cfg(AuthPlugin).set({
					mode: {
						type: 'oidc',
						issuer: 'https://issuer.example',
						clientId: 'pluxel-client',
						publicOrigin: 'https://admin.example',
						clientKind: 'public',
					},
				})
				host.start(AuthPlugin)
				await host.commit()
				expect(await host.ctx.adminAccess?.describe()).toMatchObject({
					provider: { method: 'oidc', ready: true },
				})
			},
			{ management: {}, workbench: false },
		)
	})
})
