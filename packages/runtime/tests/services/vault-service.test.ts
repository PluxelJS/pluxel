import { BasePlugin, Plugin, withRuntimeHost } from '@pluxel/runtime/test'
import { pluginNodeAddressOf } from '@pluxel/core'
import { env as stdEnv } from 'std-env'
import { describe, expect, it } from 'vitest'
import { pluginNodePhysicalKey } from '../../src/runtime/plugin-address'
import { lowerTestPlugin } from '../helpers/lowered-plugin'

type RuntimeHostLike = Parameters<Parameters<typeof withRuntimeHost>[0]>[0]

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
	it('startup preflight creates an empty shared mount before plugin access', async () => {
		await withRuntimeHost(async (host) => {
			@Plugin()
			class PluginA extends BasePlugin {}

			lowerTestPlugin(PluginA)

			host.add(PluginA)
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
		await withRuntimeHost(async (host) => {
			@Plugin()
			class PluginA extends BasePlugin {}

			lowerTestPlugin(PluginA)

			host.add(PluginA)
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
		await withRuntimeHost(
			async (host) => {
				@Plugin()
				class PluginA extends BasePlugin {}

				lowerTestPlugin(PluginA)

				host.add(PluginA)
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
		await withRuntimeHost(async (host) => {
			@Plugin()
			class PluginA extends BasePlugin {}

			@Plugin()
			class PluginB extends BasePlugin {}

			lowerTestPlugin(PluginA)

			host.add(PluginA)
			lowerTestPlugin(PluginB)
			host.add(PluginB)
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
		await withRuntimeHost(async (host) => {
			@Plugin()
			class PluginA extends BasePlugin {}

			lowerTestPlugin(PluginA)

			host.add(PluginA)
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
		await withRuntimeHost(async (host) => {
			@Plugin()
			class PluginA extends BasePlugin {}

			lowerTestPlugin(PluginA)

			host.add(PluginA)
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
		await withRuntimeHost(async (host) => {
			@Plugin()
			class PluginA extends BasePlugin {}

			lowerTestPlugin(PluginA)

			host.add(PluginA)
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
		await withRuntimeHost(async (host) => {
			@Plugin()
			class PluginA extends BasePlugin {}

			lowerTestPlugin(PluginA)

			host.add(PluginA)
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

		await withRuntimeHost(async (host) => {
			@Plugin()
			class PluginA extends BasePlugin {}

			lowerTestPlugin(PluginA)

			host.add(PluginA)
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
		await withRuntimeHost(async (host) => {
			await expect(host.ctx.vaultAdmin.rekey()).rejects.toMatchObject({
				name: 'VaultError',
				code: 'MISSING_MOUNT',
			})
			expect(await listVaultFiles(host, 'global')).toEqual([])
		}, {})
	})

	it('rekey() rewrites only the managed key envelope without rewriting the snapshot payload', async () => {
		await withRuntimeHost(async (host) => {
			@Plugin()
			class PluginA extends BasePlugin {}

			lowerTestPlugin(PluginA)

			host.add(PluginA)
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
		await withRuntimeHost(async (host) => {
			@Plugin()
			class PluginA extends BasePlugin {}

			lowerTestPlugin(PluginA)

			host.add(PluginA)
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
		await withRuntimeHost(async (host) => {
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
		await withRuntimeHost(async (host) => {
			@Plugin()
			class Seeder extends BasePlugin {}

			lowerTestPlugin(Seeder)

			host.add(Seeder)
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

		await withRuntimeHost(async (host) => {
			@Plugin()
			class Seeder extends BasePlugin {}

			lowerTestPlugin(Seeder)

			host.add(Seeder)
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
		await withRuntimeHost(async (host) => {
			@Plugin()
			class Seeder extends BasePlugin {}

			lowerTestPlugin(Seeder)

			host.add(Seeder)
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

	it('registry commit rejects before activating more plugins when vault preflight fails', async () => {
		await withRuntimeHost(async (host) => {
			@Plugin()
			class Seeder extends BasePlugin {}

			@Plugin()
			class VaultConsumer extends BasePlugin {}

			lowerTestPlugin(Seeder)

			host.add(Seeder)
			await host.commit()

			const seeder = host.require(Seeder)
			await seeder.ctx.vault.kv().set('token', 'secret')
			await seeder.ctx.vault.flush()
			await sealVaultForTesting(seeder.ctx.vault)
			await deleteVaultIdentity(host)

			lowerTestPlugin(VaultConsumer)

			host.add(VaultConsumer)
			await expect(host.commitAllowFail()).rejects.toThrow(
				'Vault mount "global" is sealed and can not be unlocked during host startup.',
			)
			expect(host.get(VaultConsumer)).toBeUndefined()

			const unlock = await host.ctx.vaultAdmin.unlock()
			expect(unlock.unlocked).toBe(false)
			expect(unlock.reason).toBe('unlock_required')
		}, {})
	})

	it('replacing deploy recipients rekeys the envelope for all saved recipients', async () => {
		await withRuntimeHost(async (host) => {
			@Plugin()
			class Seeder extends BasePlugin {}

			lowerTestPlugin(Seeder)

			host.add(Seeder)
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
