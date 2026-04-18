import { BasePlugin, Plugin, withHost } from '@pluxel/test'
import { resolve } from 'pathe'
import { env as stdEnv } from 'std-env'
import { describe, expect, it } from 'vitest'
import { securityIdentityPath } from '../../src/services/security/identity'

function bytesToHex(bytes: Uint8Array): string {
	let out = ''
	for (let i = 0; i < bytes.length; i++) out += bytes[i]!.toString(16).padStart(2, '0')
	return out
}

function randomHex(bytes: number): string {
	type WebCryptoLike = { getRandomValues: (array: Uint8Array) => Uint8Array }
	const c = (globalThis as unknown as { crypto?: WebCryptoLike }).crypto
	if (!c) throw new Error('WebCrypto is required for VaultService tests')
	const buf = new Uint8Array(bytes)
	c.getRandomValues(buf)
	return bytesToHex(buf)
}

async function sealVaultForTesting(vault: unknown): Promise<void> {
	await (vault as { sealMountForTesting: () => Promise<void> }).sealMountForTesting()
}

describe('VaultService (shared mount runtime)', () => {
	it('read-only access does not create files when the shared vault is missing', async () => {
		const dir = `/vault/${randomHex(8)}`

		await withHost(
			async (host) => {
				@Plugin({ name: 'PluginA' })
				class PluginA extends BasePlugin {}

				host.add(PluginA)
				await host.commit()

				const plugin = host.require(PluginA)
				const kv = plugin.ctx.vault.kv()
				const docs = plugin.ctx.vault.docs().collection('profiles')

				expect(await kv.get('missing')).toBeUndefined()
				expect(await kv.keys()).toEqual([])
				expect(await docs.get('default')).toBeUndefined()
				expect(host.ctx.root.fs.debugListFiles(dir)).toEqual([])
			},
			{ fs: { mode: 'memory' }, vault: { dir } },
		)
	})

	it('read-only kv batch does not create files', async () => {
		const dir = `/vault/${randomHex(8)}`

		await withHost(
			async (host) => {
				@Plugin({ name: 'PluginA' })
				class PluginA extends BasePlugin {}

				host.add(PluginA)
				await host.commit()

				const plugin = host.require(PluginA)
				const kv = plugin.ctx.vault.kv()

				await kv.batch((tx) => {
					tx.get('x')
					tx.entries()
				})

				expect(host.ctx.root.fs.debugListFiles(dir)).toEqual([])
			},
			{ fs: { mode: 'memory' }, vault: { dir } },
		)
	})

	it('first write creates one shared mount with key envelope and snapshot', async () => {
		const dir = `/vault/${randomHex(8)}`

		await withHost(
			async (host) => {
				@Plugin({ name: 'PluginA' })
				class PluginA extends BasePlugin {}

				host.add(PluginA)
				await host.commit()

				const plugin = host.require(PluginA)
				const kv = plugin.ctx.vault.kv()

				await kv.set('github.token', 'ghp_test')
				await plugin.ctx.vault.flush()
				await sealVaultForTesting(plugin.ctx.vault)

				expect(await kv.get('github.token')).toBe('ghp_test')

				const mountDir = resolve(dir, 'global')
				expect(host.ctx.root.fs.debugListFiles(dir)).toEqual([
					resolve(mountDir, 'keys.age'),
					resolve(mountDir, 'state.enc'),
				])
				expect(host.ctx.root.fs.exists(securityIdentityPath())).toBe(true)
			},
			{ fs: { mode: 'memory' }, vault: { dir } },
		)
	})

	it('flush writes one snapshot for multiple kv mutations', async () => {
		const dir = `/vault/${randomHex(8)}`

		await withHost(
			async (host) => {
				@Plugin({ name: 'PluginA' })
				class PluginA extends BasePlugin {}

				host.add(PluginA)
				await host.commit()

				const plugin = host.require(PluginA)
				const kv = plugin.ctx.vault.kv()

				await kv.set('a', '0')
				await plugin.ctx.vault.flush()
				const before = host.ctx.root.fs.debugStats()

				await kv.batch((tx) => {
					tx.set('a', '1')
					tx.set('b', '2')
					tx.set('json', { ok: true })
				})
				await plugin.ctx.vault.flush()

				const after = host.ctx.root.fs.debugStats()
				expect(after.writeBytesAtomic - before.writeBytesAtomic).toBe(1)
				expect(await kv.get('a')).toBe('1')
				expect(await kv.get('b')).toBe('2')
			},
			{ fs: { mode: 'memory' }, vault: { dir, flushDebounceMs: 1 } },
		)
	})

	it('shared mount keeps plugin namespaces separate', async () => {
		const dir = `/vault/${randomHex(8)}`

		await withHost(
			async (host) => {
				@Plugin({ name: 'PluginA' })
				class PluginA extends BasePlugin {}

				@Plugin({ name: 'PluginB' })
				class PluginB extends BasePlugin {}

				host.add(PluginA)
				host.add(PluginB)
				await host.commit()

				const a = host.require(PluginA)
				const b = host.require(PluginB)

				await a.ctx.vault.kv().set('token', 'a-secret')
				await b.ctx.vault.kv().set('token', 'b-secret')
				await a.ctx.vault.flush()

				expect(await a.ctx.vault.kv().get('token')).toBe('a-secret')
				expect(await b.ctx.vault.kv().get('token')).toBe('b-secret')
				expect(await a.ctx.vault.kv({ namespace: 'PluginB' }).get('token')).toBe('b-secret')
			},
			{ fs: { mode: 'memory' }, vault: { dir } },
		)
	})

	it('namespace() provides a stable scoped facade over kv/docs/blobs', async () => {
		const dir = `/vault/${randomHex(8)}`

		await withHost(
			async (host) => {
				@Plugin({ name: 'PluginA' })
				class PluginA extends BasePlugin {}

				host.add(PluginA)
				await host.commit()

				const plugin = host.require(PluginA)
				const space = plugin.ctx.vault.namespace()
				const kv = space.kv()
				const docs = space.docs().collection<{ ready: boolean }>('profiles')
				const blob = space.blobs().open('notes')

				expect(space.name).toBe('PluginA')
				await kv.set('token', 'value')
				await docs.set('default', { ready: true })
				await blob.writeText('scoped')
				await plugin.ctx.vault.flush()

				expect(await kv.get('token')).toBe('value')
				expect(await docs.get('default')).toEqual({ ready: true })
				expect(await blob.readText()).toBe('scoped')
			},
			{ fs: { mode: 'memory' }, vault: { dir } },
		)
	})

	it('namespace.batch() updates kv and docs atomically within one namespace copy-on-write', async () => {
		const dir = `/vault/${randomHex(8)}`

		await withHost(
			async (host) => {
				@Plugin({ name: 'PluginA' })
				class PluginA extends BasePlugin {}

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
			},
			{ fs: { mode: 'memory' }, vault: { dir } },
		)
	})

	it('tampered shared snapshot fails to decrypt after relock', async () => {
		const dir = `/vault/${randomHex(8)}`

		await withHost(
			async (host) => {
				@Plugin({ name: 'PluginA' })
				class PluginA extends BasePlugin {}

				host.add(PluginA)
				await host.commit()

				const plugin = host.require(PluginA)
				const kv = plugin.ctx.vault.kv()

				await kv.set('token', 'secret')
				await plugin.ctx.vault.flush()
				await sealVaultForTesting(plugin.ctx.vault)

				const path = resolve(dir, 'global', 'state.enc')
				const bytes = await host.ctx.root.fs.readBytes(path)
				const tampered = Uint8Array.from(bytes)
				tampered[tampered.length - 1] = (tampered[tampered.length - 1] ^ 0x01) & 0xff
				await host.ctx.root.fs.writeBytesAtomic(path, tampered)

				await expect(kv.get('token')).rejects.toMatchObject({
					name: 'VaultError',
					code: 'DECRYPT_FAILED',
				})
			},
			{ fs: { mode: 'memory' }, vault: { dir } },
		)
	})

	it('describe stays pure-read when a local host identity is available', async () => {
		const dir = `/vault/${randomHex(8)}`

		await withHost(
			async (host) => {
				@Plugin({ name: 'PluginA' })
				class PluginA extends BasePlugin {}

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
				expect(await plugin.ctx.vault.kv().get('token')).toBe('secret')
			},
			{ fs: { mode: 'memory' }, vault: { dir } },
		)
	})

	it('unlock() uses deploy key when the private identity is injected', async () => {
		const dir = `/vault/${randomHex(8)}`
		let envName = 'PLUXEL_VAULT_DEPLOY_IDENTITY'

		await withHost(
			async (host) => {
				@Plugin({ name: 'PluginA' })
				class PluginA extends BasePlugin {}

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
			},
			{ fs: { mode: 'memory' }, vault: { dir } },
		)

		delete stdEnv[envName]
	})

	it('rekey() does not create a missing mount as a side effect', async () => {
		const dir = `/vault/${randomHex(8)}`

		await withHost(
			async (host) => {
				@Plugin({ name: 'PluginA' })
				class PluginA extends BasePlugin {}

				host.add(PluginA)
				await host.commit()

				const _plugin = host.require(PluginA)

				await expect(host.ctx.vaultAdmin.rekey()).rejects.toMatchObject({
					name: 'VaultError',
					code: 'MISSING_MOUNT',
				})
				expect(host.ctx.root.fs.debugListFiles(dir)).toEqual([])
			},
			{ fs: { mode: 'memory' }, vault: { dir } },
		)
	})

	it('rekey() rewrites only the managed key envelope without rewriting the snapshot payload', async () => {
		const dir = `/vault/${randomHex(8)}`
		await withHost(
			async (host) => {
				@Plugin({ name: 'PluginA' })
				class PluginA extends BasePlugin {}

				host.add(PluginA)
				await host.commit()

				const plugin = host.require(PluginA)
				await plugin.ctx.vault.kv().set('token', 'value')
				await plugin.ctx.vault.flush()
				const before = host.ctx.root.fs.debugStats()

				await host.ctx.vaultAdmin.rekey()
				const after = host.ctx.root.fs.debugStats()
				expect(after.writeBytesAtomic - before.writeBytesAtomic).toBe(1)

				await sealVaultForTesting(plugin.ctx.vault)
				expect(await plugin.ctx.vault.kv().get('token')).toBe('value')
			},
			{ fs: { mode: 'memory' }, vault: { dir } },
		)
	})

	it('rekey() is host-key driven and does not depend on verification state', async () => {
		const dir = `/vault/${randomHex(8)}`

		await withHost(
			async (host) => {
				@Plugin({ name: 'PluginA' })
				class PluginA extends BasePlugin {}

				@Plugin({ name: 'PluginB' })
				class PluginB extends BasePlugin {}

				host.add(PluginA)
				host.add(PluginB)
				await host.commit()

				const pluginA = host.require(PluginA)
				await pluginA.ctx.vault.kv().set('token', 'value')
				await pluginA.ctx.vault.flush()
				await sealVaultForTesting(pluginA.ctx.vault)

				await host.ctx.vaultAdmin.rekey()
				await sealVaultForTesting(pluginA.ctx.vault)

				expect(await pluginA.ctx.vault.kv().get('token')).toBe('value')
			},
			{ fs: { mode: 'memory' }, vault: { dir } },
		)
	})

	it('stores blobs separately from the shared snapshot', async () => {
		const dir = `/vault/${randomHex(8)}`

		await withHost(
			async (host) => {
				@Plugin({ name: 'PluginA' })
				class PluginA extends BasePlugin {}

				host.add(PluginA)
				await host.commit()

				const plugin = host.require(PluginA)
				const blob = plugin.ctx.vault.blobs().open('notes')

				await blob.writeText('hello vault')
				expect(await blob.readText()).toBe('hello vault')
				expect(await plugin.ctx.vault.blobs().list()).toEqual(['notes'])
				expect(blob.describe().path).toBe(resolve(dir, 'global', 'blobs', 'PluginA', 'notes.blob'))
			},
			{ fs: { mode: 'memory' }, vault: { dir } },
		)
	})

	it('host preflight keeps an empty shared mount lazy', async () => {
		const dir = `/vault/${randomHex(8)}`

		await withHost(
			async (host) => {
				const admin = await host.ctx.vaultAdmin.preflight()
				expect(admin).toMatchObject({
					present: false,
					unlocked: false,
					unlockedBy: null,
				})
				const described = await host.ctx.vaultAdmin.describe()
				expect(described).toMatchObject({
					present: false,
				})
				expect(host.ctx.root.fs.debugListFiles(dir)).toEqual([])
			},
			{ fs: { mode: 'memory' }, vault: { dir } },
		)
	})

	it('host preflight fails when an existing sealed mount has no unlock identity', async () => {
		const dir = `/vault/${randomHex(8)}`

		await withHost(
			async (host) => {
				@Plugin({ name: 'Seeder' })
				class Seeder extends BasePlugin {}

				host.add(Seeder)
				await host.commit()

				const seeder = host.require(Seeder)
				await seeder.ctx.vault.kv().set('token', 'secret')
				await seeder.ctx.vault.flush()
				await sealVaultForTesting(seeder.ctx.vault)
				await host.ctx.root.fs.unlink(securityIdentityPath())

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
			},
			{ fs: { mode: 'memory' }, vault: { dir } },
		)
	})

	it('host preflight auto-unlocks from deploy identity when available', async () => {
		const dir = `/vault/${randomHex(8)}`
		let envName = 'PLUXEL_VAULT_DEPLOY_IDENTITY'

		await withHost(
			async (host) => {
				@Plugin({ name: 'Seeder' })
				class Seeder extends BasePlugin {}

				host.add(Seeder)
				await host.commit()

				const seeder = host.require(Seeder)
				await seeder.ctx.vault.kv().set('token', 'secret')
				await seeder.ctx.vault.flush()
				const pair = await host.ctx.vaultAdmin.generateDeployKey()
				envName = pair.envName
				await host.ctx.vaultAdmin.setDeployRecipients([pair.publicKey])
				await sealVaultForTesting(seeder.ctx.vault)
				await host.ctx.root.fs.unlink(securityIdentityPath())

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
			},
			{ fs: { mode: 'memory' }, vault: { dir } },
		)

		delete stdEnv[envName]
	})

	it('sealed mounts report unlock_required when no matching identity is available', async () => {
		const dir = `/vault/${randomHex(8)}`

		await withHost(
			async (host) => {
				@Plugin({ name: 'Seeder' })
				class Seeder extends BasePlugin {}

				host.add(Seeder)
				await host.commit()

				const seeder = host.require(Seeder)
				await seeder.ctx.vault.kv().set('token', 'secret')
				await seeder.ctx.vault.flush()
				await sealVaultForTesting(seeder.ctx.vault)

				await host.ctx.root.fs.unlink(securityIdentityPath())

				await expect(seeder.ctx.vault.kv().get('token')).rejects.toMatchObject({
					code: expect.stringMatching(/^(INVALID_CONFIG|DECRYPT_FAILED)$/),
				})
				const described = await host.ctx.vaultAdmin.unlock()
				expect(described).toMatchObject({
					reason: 'unlock_required',
					unlocked: false,
				})
				expect(described).toMatchObject({
					present: true,
					lastError: expect.objectContaining({
						code: expect.stringMatching(/^(INVALID_CONFIG|DECRYPT_FAILED)$/),
						message: expect.any(String),
					}),
				})
			},
			{ fs: { mode: 'memory' }, vault: { dir } },
		)
	})

	it('registry commit rejects before activating more plugins when vault preflight fails', async () => {
		const dir = `/vault/${randomHex(8)}`

		await withHost(
			async (host) => {
				@Plugin({ name: 'Seeder' })
				class Seeder extends BasePlugin {}

				@Plugin({ name: 'VaultConsumer' })
				class VaultConsumer extends BasePlugin {}

				host.add(Seeder)
				await host.commit()

				const seeder = host.require(Seeder)
				await seeder.ctx.vault.kv().set('token', 'secret')
				await seeder.ctx.vault.flush()
				await sealVaultForTesting(seeder.ctx.vault)
				await host.ctx.root.fs.unlink(securityIdentityPath())

				host.add(VaultConsumer)
				await expect(host.commitAllowFail()).rejects.toThrow(
					'Vault mount "global" is sealed and can not be unlocked during host startup.',
				)
				expect(host.get(VaultConsumer)).toBeUndefined()

				const unlock = await host.ctx.vaultAdmin.unlock()
				expect(unlock.unlocked).toBe(false)
				expect(unlock.reason).toBe('unlock_required')
			},
			{ fs: { mode: 'memory' }, vault: { dir } },
		)
	})

	it('replacing deploy recipients rekeys the envelope for all saved recipients', async () => {
		const dir = `/vault/${randomHex(8)}`

		await withHost(
			async (host) => {
				@Plugin({ name: 'Seeder' })
				class Seeder extends BasePlugin {}

				host.add(Seeder)
				await host.commit()

				const seeder = host.require(Seeder)
				await seeder.ctx.vault.kv().set('token', 'secret')
				await seeder.ctx.vault.flush()

				const pairA = await host.ctx.vaultAdmin.generateDeployKey()
				const pairB = await host.ctx.vaultAdmin.generateDeployKey()
				const admin = await host.ctx.vaultAdmin.setDeployRecipients([pairA.publicKey, pairB.publicKey, pairA.publicKey])
				expect(admin.deploy.recipients).toEqual([pairA.publicKey, pairB.publicKey])
			},
			{ fs: { mode: 'memory' }, vault: { dir } },
		)
	})
})
