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
				const plugin = host.require(AuthPlugin)
				expect(plugin.status()).toEqual({
					id: '@pluxel/auth',
					label: 'Pluxel Authentication',
					method: 'password',
					ready: false,
				})
				await expect(plugin.authenticate(new Request('https://admin.example/'))).resolves.toEqual({
					allow: false,
					reason: 'unavailable',
				})

				host.stop(AuthPlugin)
				await host.commit()
				await expect(plugin.authenticate(new Request('https://admin.example/'))).resolves.toEqual({
					allow: false,
					reason: 'unavailable',
				})
			},
			{ vault: {}, workbench: false },
		)
	})

	it('runs public OIDC without Vault and requires HTTPS for the reusable authenticator', async () => {
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
				const plugin = host.require(AuthPlugin)
				expect(plugin.status().ready).toBe(true)
				await expect(plugin.authenticate(new Request('http://127.evil.example/'))).resolves.toEqual(
					{ allow: false, reason: 'secure_transport_required' },
				)
				await expect(plugin.authenticate(new Request('http://127.0.0.1/'))).resolves.toEqual({
					allow: false,
					reason: 'secure_transport_required',
				})
			},
			{ workbench: false },
		)
	})
})
