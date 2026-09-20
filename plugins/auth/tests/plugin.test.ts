import { vault } from '@pluxel/services/vault'
import { standardServices } from '@pluxel/services'
import { createServiceInternalTestHost } from '@pluxel/services/internal/test'
import { describe, expect, it } from 'vitest'
import { AuthPlugin } from '../src/index.ts'

describe('AuthPlugin lifecycle', () => {
	it('runs in setup-required state and revokes its generation on stop', async () => {
		{
			await using host = await createServiceInternalTestHost({
				services: [...standardServices({ persistence: { mode: 'memory' } }), vault()],
				management: true,
			})

			await host.start(AuthPlugin, {
				initialConfig: { mode: { type: 'password' } },
			})
			expect(await host.ctx.adminAccess?.describe()).toEqual({
				policy: 'provider-or-local-recovery',
				provider: {
					id: '@pluxel/auth',
					label: 'Pluxel Authentication',
					method: 'password',
					ready: false,
				},
			})
			await host.stop(AuthPlugin)
			expect(await host.ctx.adminAccess?.describe()).toEqual({
				policy: 'provider-or-local-recovery',
				provider: null,
			})
		}
	})

	it('runs public OIDC without Vault', async () => {
		{
			await using host = await createServiceInternalTestHost({ management: true })

			await host.start(AuthPlugin, {
				initialConfig: {
					mode: {
						type: 'oidc',
						issuer: 'https://issuer.example',
						clientId: 'pluxel-client',
						publicOrigin: 'https://admin.example',
						clientKind: 'public',
					},
				},
			})
			expect(await host.ctx.adminAccess?.describe()).toMatchObject({
				provider: { method: 'oidc', ready: true },
			})
		}
	})
})
