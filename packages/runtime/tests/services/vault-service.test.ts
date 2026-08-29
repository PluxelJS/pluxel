import { BasePlugin, createRuntimeContext, Plugin, withRuntimeHost } from '@pluxel/runtime/test'
import { pluginNodeAddressOf } from '@pluxel/core'
import { prepareRuntimeRootContext } from '@pluxel/runtime/internal'
import { env as stdEnv } from 'std-env'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { pluginNodePhysicalKey } from '../../src/runtime/plugin-address'
import { requireWorkbench } from '../../src/services/workbench'
import type { VaultAdminService } from '../../src/services/vault/VaultService'
import type { VaultStorageApi } from '../../src/services/vault/types'
import { lowerTestPlugin } from '../helpers/lowered-plugin'

type RuntimeHostLike = Parameters<Parameters<typeof withRuntimeHost>[0]>[0]

const withVaultRuntimeHost: typeof withRuntimeHost = (run, config = {}) =>
	withRuntimeHost(run, { ...config, vault: config.vault ?? {} })

async function sealVaultForTesting(vault: unknown): Promise<void> {
	await (vault as { sealMountForTesting: () => Promise<void> }).sealMountForTesting()
}

function vaultStorage(host: RuntimeHostLike) {
	return host.ctx.root.persistence.namespace('vault')
}

function displayKey(key: string): string {
	return key.startsWith('/') ? key : `/${key}`
}

async function listVaultFiles(host: RuntimeHostLike, prefix: string): Promise<string[]> {
	const out: string[] = []
	for await (const entry of vaultStorage(host).list(prefix)) {
		if (entry.kind === 'file') out.push(displayKey(entry.key))
	}
	return out.sort()
}

async function deleteVaultIdentity(host: RuntimeHostLike): Promise<void> {
	await vaultStorage(host).delete('security/identity.json')
}

describe('VaultService (shared mount runtime)', () => {
	it('keeps optional capability types and disabled plans honest', async () => {
		const disabled = createRuntimeContext({ workbench: false, vault: false })
		try {
			expectTypeOf(disabled.ctx.vault).toEqualTypeOf<VaultStorageApi | undefined>()
			expectTypeOf(disabled.ctx.vaultAdmin).toEqualTypeOf<VaultAdminService | undefined>()
			expect('vault' in disabled.ctx).toBe(false)
			expect('vaultAdmin' in disabled.ctx).toBe(false)
			expect(disabled.ctx.workbench).toBeUndefined()
			expect(() => requireWorkbench(disabled.ctx)).toThrow('Workbench is not enabled')
		} finally {
			await disabled.dispose()
		}

		const enabled = createRuntimeContext({ workbench: false, vault: {} })
		try {
			await prepareRuntimeRootContext(enabled.ctx)
			if (!enabled.ctx.vault || !enabled.ctx.vaultAdmin) {
				throw new Error('Explicit Vault configuration did not install its capabilities')
			}
			expectTypeOf(enabled.ctx.vault).toEqualTypeOf<VaultStorageApi>()
			expectTypeOf(enabled.ctx.vaultAdmin).toEqualTypeOf<VaultAdminService>()
			expect(enabled.ctx.vault).toBeDefined()
			expect(enabled.ctx.vaultAdmin).toBeDefined()
		} finally {
			await enabled.dispose()
		}
	})

	it('deduplicates concurrent Runtime preparation and retries a failed attempt', async () => {
		const concurrent = createRuntimeContext({ workbench: false, vault: {} })
		try {
			const admin = concurrent.ctx.vaultAdmin
			if (!admin) throw new Error('Vault capability was not installed')
			let release!: () => void
			const gate = new Promise<void>((resolve) => {
				release = resolve
			})
			const prepare = vi.spyOn(admin, 'prepare').mockImplementationOnce(async () => {
				await gate
				return await admin.describe()
			})

			const first = prepareRuntimeRootContext(concurrent.ctx)
			const second = prepareRuntimeRootContext(concurrent.ctx)
			expect(first).toBe(second)
			await Promise.resolve()
			expect(prepare).toHaveBeenCalledTimes(1)
			release()
			await first
			expect(prepareRuntimeRootContext(concurrent.ctx)).toBe(first)
			expect(prepare).toHaveBeenCalledTimes(1)
		} finally {
			await concurrent.dispose()
		}

		const retry = createRuntimeContext({ workbench: false, vault: {} })
		try {
			const admin = retry.ctx.vaultAdmin
			if (!admin) throw new Error('Vault capability was not installed')
			const prepare = vi
				.spyOn(admin, 'prepare')
				.mockRejectedValueOnce(new Error('preflight failed'))
				.mockImplementationOnce(() => admin.describe())

			await expect(prepareRuntimeRootContext(retry.ctx)).rejects.toThrow('preflight failed')
			await expect(prepareRuntimeRootContext(retry.ctx)).resolves.toBeUndefined()
			expect(prepare).toHaveBeenCalledTimes(2)
		} finally {
			await retry.dispose()
		}
	})

	it('startup preflight creates an empty shared mount before plugin access', async () => {
		await withVaultRuntimeHost(async (host) => {
			@Plugin({ displayName: 'PluginA' })
			class PluginA extends BasePlugin {}

			lowerTestPlugin(PluginA)

			host.add(PluginA)
			host.cfg(PluginA).setAutoStart(true)
			host.start(PluginA)
			await host.commit()

			const plugin = host.require(PluginA)
			const kv = plugin.ctx.vault.kv()
			const docs = plugin.ctx.vault.docs().collection('profiles')

			expect(await kv.get('missing')).toBeUndefined()
			expect(await kv.keys()).toEqual([])
			expect(await docs.get('default')).toBeUndefined()

			await kv.batch((tx) => {
				tx.get('x')
				tx.entries()
			})

			expect(await listVaultFiles(host, 'global')).toEqual([
				'/global/keys.age',
				'/global/state.enc',
			])
			expect(await vaultStorage(host).stat('security/identity.json')).toBeTruthy()
		}, {})
	})

	it('writes to the preflighted shared mount with key envelope and snapshot', async () => {
		await withVaultRuntimeHost(async (host) => {
			@Plugin({ displayName: 'PluginA' })
			class PluginA extends BasePlugin {}

			lowerTestPlugin(PluginA)

			host.add(PluginA)
			host.cfg(PluginA).setAutoStart(true)
			host.start(PluginA)
			await host.commit()

			const plugin = host.require(PluginA)
			const kv = plugin.ctx.vault.kv()

			await kv.set('github.token', 'ghp_test')
			await plugin.ctx.vault.flush()
			await sealVaultForTesting(plugin.ctx.vault)
			await host.ctx.vaultAdmin.preflight()

			expect(await kv.get('github.token')).toBe('ghp_test')

			expect(await listVaultFiles(host, 'global')).toEqual([
				'/global/keys.age',
				'/global/state.enc',
			])
			expect(await vaultStorage(host).stat('security/identity.json')).toBeTruthy()
		}, {})
	})

	it('flush writes one snapshot for multiple kv mutations', async () => {
		await withVaultRuntimeHost(
			async (host) => {
				@Plugin({ displayName: 'PluginA' })
				class PluginA extends BasePlugin {}

				lowerTestPlugin(PluginA)

				host.add(PluginA)
				host.cfg(PluginA).setAutoStart(true)
				host.start(PluginA)
				await host.commit()

				const plugin = host.require(PluginA)
				const kv = plugin.ctx.vault.kv()

				await kv.set('a', '0')
				await plugin.ctx.vault.flush()
				const statePath = 'global/state.enc'
				const before = await vaultStorage(host).get(statePath)

				await kv.batch((tx) => {
					tx.set('a', '1')
					tx.set('b', '2')
					tx.set('json', { ok: true })
				})
				await plugin.ctx.vault.flush()

				const after = await vaultStorage(host).get(statePath)
				expect(before).toBeTruthy()
				expect(after).toBeTruthy()
				expect(after).not.toEqual(before)
				expect(await kv.get('a')).toBe('1')
				expect(await kv.get('b')).toBe('2')
			},
			{ vault: { flushDebounceMs: 1 } },
		)
	})

	it('shared mount keeps plugin namespaces separate', async () => {
		await withVaultRuntimeHost(async (host) => {
			@Plugin({ displayName: 'PluginA' })
			class PluginA extends BasePlugin {}

			@Plugin({ displayName: 'PluginB' })
			class PluginB extends BasePlugin {}

			lowerTestPlugin(PluginA)

			host.add(PluginA)
			host.cfg(PluginA).setAutoStart(true)
			host.start(PluginA)
			lowerTestPlugin(PluginB)
			host.add(PluginB)
			host.cfg(PluginB).setAutoStart(true)
			host.start(PluginB)
			await host.commit()

			const a = host.require(PluginA)
			const b = host.require(PluginB)

			await a.ctx.vault.kv().set('token', 'a-secret')
			await b.ctx.vault.kv().set('token', 'b-secret')
			await a.ctx.vault.flush()

			expect(await a.ctx.vault.kv().get('token')).toBe('a-secret')
			expect(await b.ctx.vault.kv().get('token')).toBe('b-secret')
			expect(await a.ctx.vault.kv({ namespace: b.ctx.vault.namespace().name }).get('token')).toBe(
				'b-secret',
			)
		}, {})
	})

	it('namespace() provides a stable scoped facade over kv/docs/blobs', async () => {
		await withVaultRuntimeHost(async (host) => {
			@Plugin({ displayName: 'PluginA' })
			class PluginA extends BasePlugin {}

			lowerTestPlugin(PluginA)

			host.add(PluginA)
			host.cfg(PluginA).setAutoStart(true)
			host.start(PluginA)
			await host.commit()

			const plugin = host.require(PluginA)
			const space = plugin.ctx.vault.namespace()
			const kv = space.kv()
			const docs = space.docs().collection<{ ready: boolean }>('profiles')
			const blob = space.blobs().open('notes')
			const ownerNamespace = `plugin-${pluginNodePhysicalKey(pluginNodeAddressOf(PluginA))}`

			expect(space.name).toBe(ownerNamespace)
			await kv.set('token', 'value')
			await docs.set('default', { ready: true })
			await blob.writeText('scoped')
			await plugin.ctx.vault.flush()

			expect(await kv.get('token')).toBe('value')
			expect(await docs.get('default')).toEqual({ ready: true })
			expect(await blob.readText()).toBe('scoped')
		}, {})
	})

	it('namespace.batch() updates kv and docs atomically within one namespace copy-on-write', async () => {
		await withVaultRuntimeHost(async (host) => {
			@Plugin({ displayName: 'PluginA' })
			class PluginA extends BasePlugin {}

			lowerTestPlugin(PluginA)

			host.add(PluginA)
			host.cfg(PluginA).setAutoStart(true)
			host.start(PluginA)
			await host.commit()

			const plugin = host.require(PluginA)
			const space = plugin.ctx.vault.namespace()

			await space.batch((tx) => {
				tx.kv.set('token', 'value')
				tx.docs.collection<{ ready: boolean }>('profiles').set('default', { ready: true })
			})
			await plugin.ctx.vault.flush()

			expect(await space.kv().get('token')).toBe('value')
			expect(await space.docs().collection<{ ready: boolean }>('profiles').get('default')).toEqual({
				ready: true,
			})
		}, {})
	})

	it('tampered shared snapshot fails to decrypt after relock', async () => {
		await withVaultRuntimeHost(async (host) => {
			@Plugin({ displayName: 'PluginA' })
			class PluginA extends BasePlugin {}

			lowerTestPlugin(PluginA)

			host.add(PluginA)
			host.cfg(PluginA).setAutoStart(true)
			host.start(PluginA)
			await host.commit()

			const plugin = host.require(PluginA)
			const kv = plugin.ctx.vault.kv()

			await kv.set('token', 'secret')
			await plugin.ctx.vault.flush()
			await sealVaultForTesting(plugin.ctx.vault)

			const path = 'global/state.enc'
			const bytes = await vaultStorage(host).get(path)
			expect(bytes).toBeTruthy()
			const tampered = Uint8Array.from(bytes!)
			tampered[tampered.length - 1] = (tampered[tampered.length - 1] ^ 0x01) & 0xff
			await vaultStorage(host).put(path, tampered, { atomic: true })

			await expect(host.ctx.vaultAdmin.preflight()).rejects.toMatchObject({
				name: 'VaultError',
				code: 'DECRYPT_FAILED',
			})
		}, {})
	})

	it('describe stays pure-read when a local host identity is available', async () => {
		await withVaultRuntimeHost(async (host) => {
			@Plugin({ displayName: 'PluginA' })
			class PluginA extends BasePlugin {}

			lowerTestPlugin(PluginA)

			host.add(PluginA)
			host.cfg(PluginA).setAutoStart(true)
			host.start(PluginA)
			await host.commit()

			const plugin = host.require(PluginA)
			await plugin.ctx.vault.kv().set('token', 'secret')
			await plugin.ctx.vault.flush()
			await sealVaultForTesting(plugin.ctx.vault)

			const admin = await host.ctx.vaultAdmin.describe()
			expect(admin).toMatchObject({
				present: true,
				unlocked: false,
				unlockedBy: null,
			})
			await host.ctx.vaultAdmin.preflight()
			expect(await plugin.ctx.vault.kv().get('token')).toBe('secret')
		}, {})
	})

	it('unlock() uses deploy key when the private identity is injected', async () => {
		let envName = 'PLUXEL_VAULT_DEPLOY_IDENTITY'

		await withVaultRuntimeHost(async (host) => {
			@Plugin({ displayName: 'PluginA' })
			class PluginA extends BasePlugin {}

			lowerTestPlugin(PluginA)

			host.add(PluginA)
			host.cfg(PluginA).setAutoStart(true)
			host.start(PluginA)
			await host.commit()

			const plugin = host.require(PluginA)
			await plugin.ctx.vault.kv().set('token', 'secret')
			await plugin.ctx.vault.flush()

			const pair = await host.ctx.vaultAdmin.generateDeployKey()
			envName = pair.envName
			await host.ctx.vaultAdmin.setDeployRecipients([pair.publicKey])
			await sealVaultForTesting(plugin.ctx.vault)

			stdEnv[envName] = pair.privateKey

			const admin = await host.ctx.vaultAdmin.unlock()
			expect(admin).toMatchObject({
				present: true,
				unlocked: true,
				unlockedBy: 'deploy',
				deploy: expect.objectContaining({
					recipients: [pair.publicKey],
					identityPresent: true,
				}),
			})
			expect(await plugin.ctx.vault.kv().get('token')).toBe('secret')
		}, {})

		delete stdEnv[envName]
	})

	it('rekey() does not create a missing mount as a side effect', async () => {
		await withVaultRuntimeHost(async (host) => {
			await expect(host.ctx.vaultAdmin.rekey()).rejects.toMatchObject({
				name: 'VaultError',
				code: 'MISSING_MOUNT',
			})
			expect(await listVaultFiles(host, 'global')).toEqual([])
		}, {})
	})

	it('rekey() rewrites only the managed key envelope without rewriting the snapshot payload', async () => {
		await withVaultRuntimeHost(async (host) => {
			@Plugin({ displayName: 'PluginA' })
			class PluginA extends BasePlugin {}

			lowerTestPlugin(PluginA)

			host.add(PluginA)
			host.cfg(PluginA).setAutoStart(true)
			host.start(PluginA)
			await host.commit()

			const plugin = host.require(PluginA)
			await plugin.ctx.vault.kv().set('token', 'value')
			await plugin.ctx.vault.flush()
			const keyPath = 'global/keys.age'
			const statePath = 'global/state.enc'
			const beforeKey = await vaultStorage(host).get(keyPath)
			const beforeState = await vaultStorage(host).get(statePath)

			await host.ctx.vaultAdmin.rekey()
			const afterKey = await vaultStorage(host).get(keyPath)
			const afterState = await vaultStorage(host).get(statePath)
			expect(beforeKey).toBeTruthy()
			expect(afterKey).toBeTruthy()
			expect(afterKey).not.toEqual(beforeKey)
			expect(afterState).toEqual(beforeState)

			await sealVaultForTesting(plugin.ctx.vault)
			await host.ctx.vaultAdmin.preflight()
			expect(await plugin.ctx.vault.kv().get('token')).toBe('value')
		}, {})
	})

	it('stores blobs separately from the shared snapshot', async () => {
		await withVaultRuntimeHost(async (host) => {
			@Plugin({ displayName: 'PluginA' })
			class PluginA extends BasePlugin {}

			lowerTestPlugin(PluginA)

			host.add(PluginA)
			host.cfg(PluginA).setAutoStart(true)
			host.start(PluginA)
			await host.commit()

			const plugin = host.require(PluginA)
			const blob = plugin.ctx.vault.blobs().open('notes')

			await blob.writeText('hello vault')
			expect(await blob.readText()).toBe('hello vault')
			expect(await plugin.ctx.vault.blobs().list()).toEqual(['notes'])
			const ownerNamespace = `plugin-${pluginNodePhysicalKey(pluginNodeAddressOf(PluginA))}`
			expect(blob.describe().path).toBe(`global/blobs/${ownerNamespace}/notes.blob`)
		}, {})
	})

	it('host preflight initializes an empty shared mount', async () => {
		await withVaultRuntimeHost(async (host) => {
			const admin = await host.ctx.vaultAdmin.preflight()
			expect(admin).toMatchObject({
				present: true,
				unlocked: true,
				unlockedBy: 'host',
			})
			const described = await host.ctx.vaultAdmin.describe()
			expect(described).toMatchObject({
				present: true,
				unlocked: true,
			})
			expect(await listVaultFiles(host, 'global')).toEqual([
				'/global/keys.age',
				'/global/state.enc',
			])
			expect(await vaultStorage(host).stat('security/identity.json')).toBeTruthy()
		}, {})
	})

	it('host preflight fails when an existing sealed mount has no unlock identity', async () => {
		await withVaultRuntimeHost(async (host) => {
			@Plugin({ displayName: 'Seeder' })
			class Seeder extends BasePlugin {}

			lowerTestPlugin(Seeder)

			host.add(Seeder)
			host.cfg(Seeder).setAutoStart(true)
			host.start(Seeder)
			await host.commit()

			const seeder = host.require(Seeder)
			await seeder.ctx.vault.kv().set('token', 'secret')
			await seeder.ctx.vault.flush()
			await sealVaultForTesting(seeder.ctx.vault)
			await deleteVaultIdentity(host)

			await expect(host.ctx.vaultAdmin.preflight()).rejects.toMatchObject({
				name: 'VaultError',
				code: 'ACCESS_DENIED',
			})
			expect(await host.ctx.vaultAdmin.describe()).toMatchObject({
				present: true,
				lastError: {
					code: 'ACCESS_DENIED',
					message: 'Vault mount "global" is sealed and can not be unlocked during host startup.',
				},
			})
		}, {})
	})

	it('host preflight auto-unlocks from deploy identity when available', async () => {
		let envName = 'PLUXEL_VAULT_DEPLOY_IDENTITY'

		await withVaultRuntimeHost(async (host) => {
			@Plugin({ displayName: 'Seeder' })
			class Seeder extends BasePlugin {}

			lowerTestPlugin(Seeder)

			host.add(Seeder)
			host.cfg(Seeder).setAutoStart(true)
			host.start(Seeder)
			await host.commit()

			const seeder = host.require(Seeder)
			await seeder.ctx.vault.kv().set('token', 'secret')
			await seeder.ctx.vault.flush()
			const pair = await host.ctx.vaultAdmin.generateDeployKey()
			envName = pair.envName
			await host.ctx.vaultAdmin.setDeployRecipients([pair.publicKey])
			await sealVaultForTesting(seeder.ctx.vault)
			await deleteVaultIdentity(host)

			stdEnv[envName] = pair.privateKey

			const admin = await host.ctx.vaultAdmin.preflight()
			expect(admin).toMatchObject({
				present: true,
				unlocked: true,
				unlockedBy: 'deploy',
				deploy: expect.objectContaining({
					identityPresent: true,
				}),
			})
			expect(await host.ctx.vaultAdmin.describe()).toMatchObject({
				present: true,
				unlocked: true,
			})
			expect(await seeder.ctx.vault.kv().get('token')).toBe('secret')
		}, {})

		delete stdEnv[envName]
	})

	it('sealed mounts report unlock_required when no matching identity is available', async () => {
		await withVaultRuntimeHost(async (host) => {
			@Plugin({ displayName: 'Seeder' })
			class Seeder extends BasePlugin {}

			lowerTestPlugin(Seeder)

			host.add(Seeder)
			host.cfg(Seeder).setAutoStart(true)
			host.start(Seeder)
			await host.commit()

			const seeder = host.require(Seeder)
			await seeder.ctx.vault.kv().set('token', 'secret')
			await seeder.ctx.vault.flush()
			await sealVaultForTesting(seeder.ctx.vault)

			await deleteVaultIdentity(host)

			await expect(seeder.ctx.vault.kv().get('token')).rejects.toMatchObject({
				code: 'ACCESS_DENIED',
			})
			const described = await host.ctx.vaultAdmin.unlock()
			expect(described).toMatchObject({
				reason: 'unlock_required',
				unlocked: false,
			})
			expect(described).toMatchObject({
				present: true,
				lastError: expect.objectContaining({
					code: 'ACCESS_DENIED',
					message: expect.any(String),
				}),
			})
		}, {})
	})

	it('does not rerun host preflight during later graph commits', async () => {
		await withVaultRuntimeHost(async (host) => {
			@Plugin({ displayName: 'Seeder' })
			class Seeder extends BasePlugin {}

			@Plugin({ displayName: 'VaultConsumer' })
			class VaultConsumer extends BasePlugin {}

			lowerTestPlugin(Seeder)

			host.add(Seeder)
			host.cfg(Seeder).setAutoStart(true)
			host.start(Seeder)
			await host.commit()

			const seeder = host.require(Seeder)
			await seeder.ctx.vault.kv().set('token', 'secret')
			await seeder.ctx.vault.flush()
			await sealVaultForTesting(seeder.ctx.vault)
			await deleteVaultIdentity(host)

			lowerTestPlugin(VaultConsumer)

			host.add(VaultConsumer)
			host.cfg(VaultConsumer).setAutoStart(true)
			host.start(VaultConsumer)
			await expect(host.commitAllowFail()).resolves.toBeDefined()
			expect(host.get(VaultConsumer)).toBeDefined()

			const unlock = await host.ctx.vaultAdmin.unlock()
			expect(unlock.unlocked).toBe(false)
			expect(unlock.reason).toBe('unlock_required')
		}, {})
	})

	it('replacing deploy recipients rekeys the envelope for all saved recipients', async () => {
		await withVaultRuntimeHost(async (host) => {
			@Plugin({ displayName: 'Seeder' })
			class Seeder extends BasePlugin {}

			lowerTestPlugin(Seeder)

			host.add(Seeder)
			host.cfg(Seeder).setAutoStart(true)
			host.start(Seeder)
			await host.commit()

			const seeder = host.require(Seeder)
			await seeder.ctx.vault.kv().set('token', 'secret')
			await seeder.ctx.vault.flush()

			const pairA = await host.ctx.vaultAdmin.generateDeployKey()
			const pairB = await host.ctx.vaultAdmin.generateDeployKey()
			const admin = await host.ctx.vaultAdmin.setDeployRecipients([
				pairA.publicKey,
				pairB.publicKey,
				pairA.publicKey,
			])
			expect(admin.deploy.recipients).toEqual([pairA.publicKey, pairB.publicKey])
		}, {})
	})
})
