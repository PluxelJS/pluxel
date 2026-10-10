import { pluginNodeAddressOf } from '@pluxel/core'
import { createHost, defineHostApplication, envBinding, resolveHostApplication } from '@pluxel/host'
import { AdminAccess, managementAccess } from '@pluxel/services/management/access'
import { vault } from '@pluxel/services/vault'
import { describe, expect, it } from 'vitest'
import { AuthConfig, AuthPlugin, AuthVaultSchema } from '../src/index.ts'
import { hashPassword } from '../src/password.ts'

describe('Auth headless deployment', () => {
	it.each(['password', 'oidc'] as const)(
		'starts ready with %s credentials from a Vault binding and no Workbench',
		async (mode) => {
			const recordKey = mode === 'password' ? 'management-account-v1' : 'oidc-client-secret-v1'
			const application = defineHostApplication(() => ({
				plugins: [AuthPlugin],
				services: [managementAccess(), vault({ backend: 'bindings' })],
				state: { initial: { autoStart: [pluginNodeAddressOf(AuthPlugin)] } },
				configRecords: {
					initial: [
						{ owner: pluginNodeAddressOf(AuthPlugin), config: { mode: { type: 'password' } } },
					],
				},
				envBindings: [
					envBinding(AuthPlugin, {
						config: { schema: AuthConfig, mapping: { mode: 'AUTH_MODE' } },
						vault: { schema: AuthVaultSchema, mapping: { [recordKey]: 'AUTH_CREDENTIAL' } },
					}),
				],
			}))
			const credential =
				mode === 'password'
					? {
							version: 1,
							type: 'local-account',
							username: 'Admin',
							normalizedUsername: 'admin',
							password: await hashPassword('correct horse battery staple'),
						}
					: { version: 1, type: 'oidc-client-secret', secret: 'deployment-client-secret' }
			const modeConfig =
				mode === 'password'
					? { type: 'password' }
					: {
							type: 'oidc',
							issuer: 'https://issuer.example',
							clientId: 'client',
							publicOrigin: 'https://admin.example',
							clientKind: 'confidential',
						}
			const resolved = await resolveHostApplication(application, {
				root: process.cwd(),
				mode: 'test',
				bindings: {},
				env: { AUTH_MODE: JSON.stringify(modeConfig), AUTH_CREDENTIAL: JSON.stringify(credential) },
			})
			const host = await createHost({
				plugins: resolved.plugins,
				services: resolved.services,
				state: resolved.state,
				config: resolved.config,
				configRecords: resolved.configRecords,
				vaultBindings: resolved.vaultBindings,
			})
			try {
				await host.start()
				expect(host.ctx.workbench).toBeUndefined()
				const config = await host.config.get(pluginNodeAddressOf(AuthPlugin))
				expect(config).toMatchObject({ ok: true, config: { mode: modeConfig } })
				expect(JSON.stringify(config)).not.toContain('deployment-client-secret')
				expect(JSON.stringify(config)).not.toContain('"password":')
				expect(await host.ctx.require(AdminAccess).describe()).toMatchObject({
					provider: { method: mode, ready: true },
				})
			} finally {
				await host.close()
			}
			await expect(
				resolveHostApplication(application, {
					root: process.cwd(),
					mode: 'test',
					bindings: {},
					env: { AUTH_MODE: JSON.stringify(modeConfig) },
				}),
			).rejects.toThrow(/AUTH_CREDENTIAL/)
		},
	)
})
