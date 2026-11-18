import { AdminAccess } from '@pluxel/services/management/access'
import { elysia } from '@pluxel/services/elysia'
import { commands } from '@pluxel/services/commands'
import { nodeModules } from '@pluxel/services/node'
import { workers } from '@pluxel/services/workers'
import { createServiceInternalTestHost } from '@pluxel/services/internal/test'
import { describe, expect, it } from 'vitest'
import { AuthPlugin } from '../src/index.ts'

describe('AuthPlugin lifecycle', () => {
	it('runs in setup-required state and revokes its generation on stop', async () => {
		{
			await using host = await createServiceInternalTestHost({
				services: [elysia(), commands(), nodeModules(), workers()],
				management: true,
			})

			await host.start(AuthPlugin.nodeAddress(), {
				initialConfig: { mode: { type: 'password' } },
			})
			expect(await host.ctx.service(AdminAccess)?.describe()).toEqual({
				policy: 'provider-or-local-recovery',
				provider: {
					id: '@pluxel/plugin-auth',
					label: 'Pluxel Authentication',
					method: 'password',
					ready: false,
				},
			})
			await host.stop(AuthPlugin.nodeAddress())
			expect(await host.ctx.service(AdminAccess)?.describe()).toEqual({
				policy: 'provider-or-local-recovery',
				provider: null,
			})
		}
	})

	it('runs public OIDC without accessing credential storage', async () => {
		{
			await using host = await createServiceInternalTestHost({ management: true })

			await host.start(AuthPlugin.nodeAddress(), {
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
			expect(await host.ctx.service(AdminAccess)?.describe()).toMatchObject({
				provider: { method: 'oidc', ready: true },
			})
		}
	})
})
