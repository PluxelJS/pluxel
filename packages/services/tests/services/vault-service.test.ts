import { describe, expect, it } from 'vitest'
import { createHost } from '@pluxel/host'
import { HostVaultBindings } from '@pluxel/host/bindings'
import { BasePlugin, Plugin, pluginNodeAddressOf } from '@pluxel/core'
import {
	persistence,
	createMemoryPersistenceBackend,
	type PersistenceBackend,
} from '../../src/persistence'
import {
	vault,
	Vault,
	VaultAdmin,
	type VaultServiceConfig,
	type VaultStorageApi,
	type VaultKvTransaction,
} from '../../src/vault'
import { Decrypter } from 'age-encryption'

function setup(backend = createMemoryPersistenceBackend(), config?: VaultServiceConfig) {
	return createHost({
		plugins: [],
		services: [persistence({ mode: 'custom', backend }), vault(config)],
	})
}
const owners = new Map<string, VaultStorageApi>()
@Plugin()
class Owner extends BasePlugin {
	init() {
		owners.set('one', this.ctx.require(Vault))
	}
}
@Plugin()
class OtherOwner extends BasePlugin {
	init() {
		owners.set('two', this.ctx.require(Vault))
	}
}

function decode(bytes: Uint8Array) {
	return new TextDecoder().decode(bytes)
}
async function decryptState(backend: PersistenceBackend) {
	const storage = backend.namespace('vault')
	const identity = JSON.parse((await storage.getText('security/identity.json'))!)
	const decrypter = new Decrypter()
	decrypter.addIdentity(identity.vault.hostIdentity)
	const dek = await decrypter.decrypt((await storage.get('global/keys.age'))!)
	const key = await crypto.subtle.importKey('raw', dek as BufferSource, 'AES-GCM', false, [
		'decrypt',
		'encrypt',
	])
	const bytes = (await storage.get('global/state.enc'))!
	const plain = await crypto.subtle.decrypt(
		{ name: 'AES-GCM', iv: bytes.slice(5, 17) },
		key,
		bytes.slice(17),
	)
	return { key, snapshot: JSON.parse(decode(new Uint8Array(plain))) }
}
async function replaceSnapshot(backend: PersistenceBackend, snapshot: unknown) {
	const { key } = await decryptState(backend)
	const nonce = crypto.getRandomValues(new Uint8Array(12))
	const cipher = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: 'AES-GCM', iv: nonce },
			key,
			new TextEncoder().encode(JSON.stringify(snapshot)),
		),
	)
	await backend
		.namespace('vault')
		.put(
			'global/state.enc',
			new Uint8Array([...new TextEncoder().encode('PVLT2'), ...nonce, ...cipher]),
			{ atomic: true },
		)
}

describe('Vault structured records', () => {
	it('commits immutable snapshots before returning and preserves revision tombstones across restart', async () => {
		const backend = createMemoryPersistenceBackend()
		const host = await setup(backend)
		try {
			const kv = host.ctx.require(Vault).kv()
			const input = { token: 'secret', nested: { enabled: true } }
			expect(await kv.get('account')).toMatchObject({
				exists: false,
				revision: 0,
				writable: true,
			})
			const first = await kv.set('account', input, { expectedRevision: 0 })
			input.nested.enabled = false
			expect(first).toMatchObject({ revision: 1, value: { nested: { enabled: true } } })
			expect(Object.isFrozen(first)).toBe(true)
			expect(Object.isFrozen((first.value as typeof input).nested)).toBe(true)
			await expect(kv.set('account', 'stale', { expectedRevision: 0 })).rejects.toMatchObject({
				code: 'REVISION_CONFLICT',
			})
			expect(
				await kv.delete('account', { expectedRevision: 1 }).then((result) => result.revision),
			).toBe(2)
			expect(
				await kv.set('account', 'new', { expectedRevision: 2 }).then((result) => result.revision),
			).toBe(3)
		} finally {
			await host.close()
		}
		const reopened = await setup(backend)
		try {
			expect(await reopened.ctx.require(Vault).kv().get('account')).toMatchObject({
				revision: 3,
				value: 'new',
			})
		} finally {
			await reopened.close()
		}
	})

	it('does not publish values, revisions or notifications when persistent commit fails', async () => {
		const memory = createMemoryPersistenceBackend()
		let reject = false
		const backend: PersistenceBackend = {
			capability: memory.capability,
			namespace(name) {
				const storage = memory.namespace(name)
				return {
					...storage,
					async put(key, value, options) {
						if (reject && key.endsWith('state.enc')) throw new Error('commit rejected')
						await storage.put(key, value, options)
					},
				}
			},
		}
		const host = await setup(backend)
		try {
			const kv = host.ctx.require(Vault).kv()
			await kv.set('token', 'old')
			const observed: unknown[] = []
			const subscription = await kv.watch('token', (value) => {
				observed.push(value)
			})
			reject = true
			await expect(kv.set('token', 'new')).rejects.toThrow('commit rejected')
			expect(await kv.get('token')).toEqual(subscription.snapshot)
			expect(observed).toEqual([])
			reject = false
			expect(await kv.set('token', 'committed').then((result) => result.revision)).toBe(2)
		} finally {
			reject = false
			await host.close()
		}
	})

	it('commits a batch atomically, rolls back conflicts and prevents retained transaction access', async () => {
		const host = await setup()
		try {
			const kv = host.ctx.require(Vault).kv()
			let retained!: VaultKvTransaction
			await kv.batch((tx) => {
				retained = tx
				tx.set('one', 1)
				tx.set('two', 2)
			})
			expect(() => retained.set('late', 3)).toThrow('closed')
			await expect(
				kv.batch((tx) => {
					tx.set('one', 9)
					tx.delete('two', { expectedRevision: 0 })
				}),
			).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
			expect(await kv.get('one').then((result) => result.value)).toBe(1)
			expect(await kv.get('two').then((result) => result.value)).toBe(2)
			expect(await kv.keys({ after: 'one', limit: 1 })).toEqual(['two'])
			await expect(kv.keys({ limit: 1001 })).rejects.toMatchObject({ code: 'INVALID_CONFIG' })
		} finally {
			await host.close()
		}
	})

	it('atomically watches the initial snapshot, observes committed data outside the lock and isolates listener failures', async () => {
		const host = await setup()
		try {
			const kv = host.ctx.require(Vault).kv()
			const observed: number[] = []
			const sub = await kv.watch('token', async (snapshot) => {
				observed.push(snapshot.revision)
				expect(await kv.get('token').then((result) => result.revision)).toBeGreaterThanOrEqual(
					snapshot.revision,
				)
				throw new Error('consumer apply failed')
			})
			expect(sub.snapshot.revision).toBe(0)
			await kv.set('token', 'a')
			await expect.poll(() => observed).toEqual([1])
			await kv.set('token', 'b')
			await expect.poll(() => observed).toEqual([1, 2])
			sub.dispose()
			await kv.set('token', 'c')
			expect(observed).toEqual([1, 2])
		} finally {
			await host.close()
		}
	})

	it('rejects values that cannot form an immutable JSON snapshot without invoking accessors', async () => {
		const host = await setup()
		try {
			const kv = host.ctx.require(Vault).kv()
			const cycle: Record<string, unknown> = {}
			cycle.self = cycle
			for (const value of [
				new Date(),
				Number.NaN,
				undefined,
				cycle,
				{
					get secret() {
						throw new Error('getter ran')
					},
				},
			]) {
				await expect(kv.set('invalid', value)).rejects.toMatchObject({ code: 'INVALID_FORMAT' })
			}
			expect(await kv.get('invalid').then((result) => result.revision)).toBe(0)
		} finally {
			await host.close()
		}
	})

	it('serves bindings without Persistence, disk, encryption keys or writable fallback', async () => {
		const host = await createHost({
			plugins: [Owner, OtherOwner],
			services: [vault({ backend: 'bindings' })],
		})
		try {
			host.ctx.require(HostVaultBindings).install([
				{
					owner: pluginNodeAddressOf(Owner),
					key: 'primary',
					value: { token: 'from-env' },
					source: 'env',
				},
				{ owner: pluginNodeAddressOf(Owner), key: 'missing', value: undefined, source: 'env' },
			])
			await host.startNode(pluginNodeAddressOf(Owner))
			await host.startNode(pluginNodeAddressOf(OtherOwner))
			const first = host.ctx.require(Vault).kv({
				namespace: `plugin-${(await import('../../src/internal/plugin-address').then((result) => result.pluginNodePhysicalKey))(pluginNodeAddressOf(Owner))}`,
			})
			expect(await first.get('primary')).toMatchObject({
				source: 'env',
				writable: false,
				value: { token: 'from-env' },
			})
			expect(await first.get('missing')).toMatchObject({
				source: 'env',
				exists: false,
				writable: false,
			})
			await expect(first.set('primary', 'new')).rejects.toMatchObject({ code: 'READ_ONLY' })
			expect(await host.ctx.require(VaultAdmin).describe()).toMatchObject({
				present: false,
				hostIdentityPresent: false,
			})
			await expect(first.get('unknown')).resolves.toMatchObject({ exists: false, writable: false })
		} finally {
			await host.close()
		}
	})

	it('overlays whole records without mixing or persisting deployment values', async () => {
		const backend = createMemoryPersistenceBackend()
		const host = await setup(backend)
		const namespace = `plugin-${(await import('../../src/internal/plugin-address').then((result) => result.pluginNodePhysicalKey))(pluginNodeAddressOf(Owner))}`
		try {
			const kv = host.ctx.require(Vault).kv({ namespace })
			await kv.set('primary', { refreshToken: 'persisted' })
			host.ctx.require(HostVaultBindings).install([
				{
					owner: pluginNodeAddressOf(Owner),
					key: 'primary',
					value: { token: 'deployment' },
					source: 'file',
				},
			])
			expect(await kv.get('primary').then((result) => result.value)).toEqual({
				token: 'deployment',
			})
			await expect(
				kv.batch((tx) => {
					tx.set('other', 1)
					tx.delete('primary')
				}),
			).rejects.toMatchObject({ code: 'READ_ONLY' })
			expect(await kv.get('other').then((result) => result.exists)).toBe(false)
		} finally {
			await host.close()
		}
		const next = await setup(backend)
		try {
			expect(
				await next.ctx
					.require(Vault)
					.kv({ namespace })
					.get('primary')
					.then((result) => result.value),
			).toEqual({ refreshToken: 'persisted' })
		} finally {
			await next.close()
		}
	})

	it('watches new keys and deletions in a prefix and never leaks another owner namespace', async () => {
		const host = await createHost({
			plugins: [Owner, OtherOwner],
			services: [persistence({ mode: 'memory' }), vault()],
		})
		try {
			await host.startNode(pluginNodeAddressOf(Owner))
			await host.startNode(pluginNodeAddressOf(OtherOwner))
			const one = owners.get('one')!.namespace('accounts').kv()
			const two = owners.get('two')!.namespace('accounts').kv()
			await one.set('account/first', { token: 'one' })
			expect(await two.get('account/first').then((result) => result.exists)).toBe(false)
			const seen: Array<[string, boolean]> = []
			const sub = await one.watchPrefix('account/', (snapshot) => {
				seen.push([snapshot.key, snapshot.exists])
			})
			expect(sub.snapshots.map((snapshot) => snapshot.key)).toEqual(['account/first'])
			await one.set('account/new', 'new')
			await expect.poll(() => seen).toEqual([['account/new', true]])
			await one.delete('account/first')
			await expect
				.poll(() => seen)
				.toEqual([
					['account/new', true],
					['account/first', false],
				])
			await host.stopNode(pluginNodeAddressOf(Owner))
			await expect(one.get('account/new')).rejects.toThrow('stopped')
			sub.dispose()
		} finally {
			await host.close()
		}
	})

	it.each([undefined, 1, 3])(
		'rejects unsupported snapshot version %s without rewriting storage',
		async (version) => {
			const backend = createMemoryPersistenceBackend()
			const host = await setup(backend)
			await host.close()
			await replaceSnapshot(backend, {
				kind: 'pluxel.vault.snapshot',
				version,
				namespaces: { default: { kv: { token: 'saved' }, revisions: { token: 1 } } },
			})
			const storage = backend.namespace('vault')
			const before = await storage.get('global/state.enc')
			await expect(setup(backend)).rejects.toMatchObject({ code: 'INVALID_FORMAT' })
			expect(await storage.get('global/state.enc')).toEqual(before)
		},
	)

	it.each([undefined, {}, { token: 0 }, { token: 1.5 }])(
		'rejects invalid snapshot revisions %j without rewriting storage',
		async (revisions) => {
			const backend = createMemoryPersistenceBackend()
			const host = await setup(backend)
			await host.close()
			await replaceSnapshot(backend, {
				kind: 'pluxel.vault.snapshot',
				version: 2,
				namespaces: { default: { kv: { token: 'saved' }, revisions } },
			})
			const storage = backend.namespace('vault')
			const before = await storage.get('global/state.enc')
			await expect(setup(backend)).rejects.toMatchObject({ code: 'INVALID_FORMAT' })
			expect(await storage.get('global/state.enc')).toEqual(before)
		},
	)

	it('rekeys only the envelope, reopens with explicit deployment identity and rejects missing or damaged state', async () => {
		const backend = createMemoryPersistenceBackend()
		const host = await setup(backend)
		const storage = backend.namespace('vault')
		await host.ctx.require(Vault).kv().set('token', 'secret')
		const before = await storage.get('global/state.enc')
		const pair = await host.ctx.require(VaultAdmin).generateDeployKey()
		await host.ctx.require(VaultAdmin).setDeployRecipients([pair.publicKey])
		await host.ctx.require(VaultAdmin).rekey()
		expect(await storage.get('global/state.enc')).toEqual(before)
		await host.close()
		await storage.delete('security/identity.json')
		await expect(setup(backend)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
		const unlocked = await setup(backend, { deployIdentity: pair.privateKey })
		try {
			expect(
				await unlocked.ctx
					.require(Vault)
					.kv()
					.get('token')
					.then((result) => result.value),
			).toBe('secret')
			expect(
				await unlocked.ctx
					.require(VaultAdmin)
					.describe()
					.then((result) => result.unlockedBy),
			).toBe('deploy')
		} finally {
			await unlocked.close()
		}
		const original = (await storage.get('global/state.enc'))!
		const damaged = new Uint8Array(original)
		damaged[damaged.length - 1] ^= 1
		await storage.put('global/state.enc', damaged)
		await expect(setup(backend, { deployIdentity: pair.privateKey })).rejects.toMatchObject({
			code: 'DECRYPT_FAILED',
		})
		expect(await storage.get('global/state.enc')).toEqual(damaged)
		await storage.delete('global/state.enc')
		await expect(setup(backend, { deployIdentity: pair.privateKey })).rejects.toMatchObject({
			code: 'INVALID_FORMAT',
		})
	})
})
