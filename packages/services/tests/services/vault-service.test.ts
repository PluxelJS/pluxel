import { InMemory, Passthrough, type FsConfig } from '@pluxel/core/fs'
import { requireFs, requireVaultHost } from '@pluxel/core/internal'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as nativeFs from 'node:fs'
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHost } from '@pluxel/host'
import { BasePlugin, Plugin } from '@pluxel/core'
import {
	type VaultServiceConfig,
	type VaultStorageApi,
	type VaultKvTransaction,
} from '@pluxel/core/vault'
import { Decrypter } from 'age-encryption'

const directories: string[] = []
afterEach(async () => {
	vi.restoreAllMocks()
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function diskConfig() {
	const prefix = await mkdtemp(join(tmpdir(), 'pluxel-vault-'))
	directories.push(prefix)
	return {
		mounts: { '/': { backend: Passthrough, fs: nativeFs, prefix } },
		durableMounts: ['/'],
	} as const
}
type DiskConfig = Awaited<ReturnType<typeof diskConfig>>
const vaultPath = (config: DiskConfig, key: string) =>
	join(config.mounts['/'].prefix, 'services/vault', key)
function setup(
	config: FsConfig = { mounts: { '/': { backend: InMemory } } },
	vaultConfig?: VaultServiceConfig,
) {
	return createHost({
		plugins: [],
		services: [],
		coreConfig: { zenfs: config, vault: vaultConfig },
	})
}
const owners = new Map<string, VaultStorageApi>()
@Plugin()
class Owner extends BasePlugin {
	init() {
		owners.set('one', this.ctx.vault)
	}
}
@Plugin()
class OtherOwner extends BasePlugin {
	init() {
		owners.set('two', this.ctx.vault)
	}
}

function decode(bytes: Uint8Array) {
	return new TextDecoder().decode(bytes)
}
async function decryptState(backend: DiskConfig) {
	const identity = JSON.parse(await readFile(vaultPath(backend, 'security/identity.json'), 'utf8'))
	const decrypter = new Decrypter()
	decrypter.addIdentity(identity.vault.hostIdentity)
	const dek = await decrypter.decrypt(await readFile(vaultPath(backend, 'global/keys.age')))
	const key = await crypto.subtle.importKey('raw', dek as BufferSource, 'AES-GCM', false, [
		'decrypt',
		'encrypt',
	])
	const bytes = await readFile(vaultPath(backend, 'global/state.enc'))
	const plain = await crypto.subtle.decrypt(
		{ name: 'AES-GCM', iv: bytes.slice(5, 17) },
		key,
		bytes.slice(17),
	)
	return { key, snapshot: JSON.parse(decode(new Uint8Array(plain))) }
}
async function replaceSnapshot(backend: DiskConfig, snapshot: unknown) {
	const { key } = await decryptState(backend)
	const nonce = crypto.getRandomValues(new Uint8Array(12))
	const cipher = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: 'AES-GCM', iv: nonce },
			key,
			new TextEncoder().encode(JSON.stringify(snapshot)),
		),
	)
	await writeFile(
		vaultPath(backend, 'global/state.enc'),
		new Uint8Array([...new TextEncoder().encode('PVLT2'), ...nonce, ...cipher]),
	)
}

describe('Vault structured records', () => {
	it('creates and exposes owner credentials lazily without generating keys during management reads', async () => {
		const backend = await diskConfig()
		const host = await createHost({ plugins: [{ plugin: Owner }], coreConfig: { zenfs: backend } })
		try {
			await host.startNode(Owner.nodeAddress())
			const vault = owners.get('one')!
			expect(vault.kv()).toBeDefined()
			expect(vault.blobs().open('unused')).toBeDefined()
			await vault.flush()
			expect(await requireVaultHost(host.ctx).admin.describe()).toMatchObject({
				present: false,
				unlocked: false,
				hostIdentityPresent: false,
			})
			expect(nativeFs.existsSync(vaultPath(backend, 'security/identity.json'))).toBe(false)
			expect(nativeFs.existsSync(vaultPath(backend, 'global/keys.age'))).toBe(false)
			expect(nativeFs.existsSync(vaultPath(backend, 'global/state.enc'))).toBe(false)
			await expect(vault.kv().get('missing')).resolves.toMatchObject({
				exists: false,
				writable: true,
			})
			expect(nativeFs.existsSync(vaultPath(backend, 'security/identity.json'))).toBe(true)
		} finally {
			await host.close()
		}
	})

	it('reloads shared encrypted files, including replaced revisions, without writing them back', async () => {
		const backend = await diskConfig()
		const writer = await setup(backend)
		await requireVaultHost(writer.ctx).admin.unlock()
		const reader = await setup(backend)
		const directory = await requireFs(reader.ctx).directory('services/vault')
		const writes = vi.spyOn(directory, 'rename')
		const reads = vi.spyOn(directory, 'readFile')
		const observed: unknown[] = []
		try {
			const source = requireVaultHost(writer.ctx).forOwner(writer.ctx).kv()
			const target = requireVaultHost(reader.ctx).forOwner(reader.ctx).kv()
			const subscription = await target.watch('token', (snapshot) => {
				observed.push({ value: snapshot.value, revision: snapshot.revision })
			})
			expect(subscription.snapshot.exists).toBe(false)
			await source.set('token', 'first')
			await expect.poll(() => target.get('token')).toMatchObject({ value: 'first', revision: 1 })
			await source.set('token', 'second')
			await expect
				.poll(() => observed)
				.toEqual([
					{ value: 'first', revision: 1 },
					{ value: 'second', revision: 2 },
				])

			// An external editor/backup can replace content without advancing this instance's revision.
			const { snapshot } = await decryptState(backend)
			snapshot.namespaces.default.kv.token = 'external'
			snapshot.namespaces.default.revisions.token = 1
			await replaceSnapshot(backend, snapshot)
			await expect.poll(() => target.get('token')).toMatchObject({ value: 'external', revision: 1 })
			snapshot.namespaces.default.kv.token = 'same revision'
			await replaceSnapshot(backend, snapshot)
			await expect
				.poll(() => target.get('token'))
				.toMatchObject({ value: 'same revision', revision: 1 })
			delete snapshot.namespaces.default
			await replaceSnapshot(backend, snapshot)
			await expect
				.poll(() => observed)
				.toEqual([
					{ value: 'first', revision: 1 },
					{ value: 'second', revision: 2 },
					{ value: 'external', revision: 1 },
					{ value: 'same revision', revision: 1 },
					{ value: undefined, revision: 0 },
				])
			await requireVaultHost(reader.ctx).forOwner(reader.ctx).flush()
			expect(writes).not.toHaveBeenCalled()
			await reader.close()
			const readsAfterClose = reads.mock.calls.length
			await source.set('token', 'after close')
			await new Promise((resolve) => setTimeout(resolve, 350))
			expect(reads.mock.calls).toHaveLength(readsAfterClose)
			expect(writes).not.toHaveBeenCalled()
			expect(observed).toHaveLength(5)
		} finally {
			await reader.close()
			await writer.close()
		}
	})

	it('retains valid state on a damaged external snapshot and resumes after the file is repaired', async () => {
		const backend = await diskConfig()
		const host = await setup(backend)
		try {
			const kv = requireVaultHost(host.ctx).forOwner(host.ctx).kv()
			await kv.set('token', 'valid')
			const path = vaultPath(backend, 'global/state.enc')
			const valid = await readFile(path)
			const damaged = new Uint8Array(valid)
			damaged[damaged.length - 1] ^= 1
			await writeFile(path, damaged)
			await expect
				.poll(() => requireVaultHost(host.ctx).admin.describe())
				.toMatchObject({
					lastError: { code: 'DECRYPT_FAILED' },
				})
			expect(await kv.get('token')).toMatchObject({ value: 'valid' })
			expect(new Uint8Array(await readFile(path))).toEqual(damaged)
			await writeFile(path, valid)
			await expect
				.poll(async () => {
					const state = await requireVaultHost(host.ctx).admin.describe()
					return state.lastError
				})
				.toBeUndefined()
			expect(await readFile(path)).toEqual(valid)
		} finally {
			await host.close()
		}
	})

	it('commits immutable snapshots before returning and preserves revision tombstones across restart', async () => {
		const backend = await diskConfig()
		const host = await setup(backend)
		try {
			const kv = requireVaultHost(host.ctx).forOwner(host.ctx).kv()
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
			expect(
				await requireVaultHost(reopened.ctx).forOwner(reopened.ctx).kv().get('account'),
			).toMatchObject({
				revision: 3,
				value: 'new',
			})
		} finally {
			await reopened.close()
		}
	})

	it('does not publish values, revisions or notifications when persistent commit fails', async () => {
		let reject = false
		const host = await setup()
		const directory = await requireFs(host.ctx).directory('services/vault')
		const rename = directory.rename
		vi.spyOn(directory, 'rename').mockImplementation(async (from, to) => {
			if (reject && String(to).endsWith('state.enc')) throw new Error('commit rejected')
			await Reflect.apply(rename, directory, [from, to])
		})
		try {
			const kv = requireVaultHost(host.ctx).forOwner(host.ctx).kv()
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
			const kv = requireVaultHost(host.ctx).forOwner(host.ctx).kv()
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
			const kv = requireVaultHost(host.ctx).forOwner(host.ctx).kv()
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
			const kv = requireVaultHost(host.ctx).forOwner(host.ctx).kv()
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

	it('serves bindings without Fs, disk, encryption keys or writable fallback', async () => {
		const host = await createHost({
			plugins: [{ plugin: Owner }, { plugin: OtherOwner }],
			coreConfig: { vault: { backend: 'bindings' } },
		})
		try {
			requireVaultHost(host.ctx).installBindings([
				{
					owner: Owner.nodeAddress(),
					key: 'primary',
					value: { token: 'from-env' },
					source: 'env',
				},
				{ owner: Owner.nodeAddress(), key: 'missing', value: undefined, source: 'env' },
			])
			await host.startNode(Owner.nodeAddress())
			await host.startNode(OtherOwner.nodeAddress())
			const first = requireVaultHost(host.ctx)
				.forOwner(host.ctx)
				.kv({
					namespace: `plugin-${(await import('@pluxel/core/internal').then((result) => result.pluginNodePhysicalKey))(Owner.nodeAddress())}`,
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
			expect(await requireVaultHost(host.ctx).admin.describe()).toMatchObject({
				present: false,
				hostIdentityPresent: false,
			})
			await expect(first.get('unknown')).resolves.toMatchObject({ exists: false, writable: false })
		} finally {
			await host.close()
		}
	})

	it('overlays whole records without mixing or persisting deployment values', async () => {
		const backend = await diskConfig()
		const namespace = `plugin-${(await import('@pluxel/core/internal').then((result) => result.pluginNodePhysicalKey))(Owner.nodeAddress())}`
		{
			await using saved = await setup(backend)
			await requireVaultHost(saved.ctx).forOwner(saved.ctx).kv({ namespace }).set('primary', {
				refreshToken: 'persisted',
			})
		}
		const host = await createHost({
			plugins: [],
			coreConfig: { zenfs: backend },
			vaultBindings: [
				{
					owner: Owner.nodeAddress(),
					key: 'primary',
					value: { token: 'deployment' },
					source: 'file',
				},
			],
		})
		try {
			const kv = requireVaultHost(host.ctx).forOwner(host.ctx).kv({ namespace })
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
				await requireVaultHost(next.ctx)
					.forOwner(next.ctx)
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
			plugins: [{ plugin: Owner }, { plugin: OtherOwner }],
			services: [],
		})
		try {
			await host.startNode(Owner.nodeAddress())
			await host.startNode(OtherOwner.nodeAddress())
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
			await host.stopNode(Owner.nodeAddress())
			await expect(one.get('account/new')).rejects.toThrow('stopped')
			sub.dispose()
		} finally {
			await host.close()
		}
	})

	it.each([undefined, 1, 3])(
		'rejects unsupported snapshot version %s without rewriting storage',
		async (version) => {
			const backend = await diskConfig()
			const host = await setup(backend)
			await requireVaultHost(host.ctx).admin.unlock()
			await host.close()
			await replaceSnapshot(backend, {
				kind: 'pluxel.vault.snapshot',
				version,
				namespaces: { default: { kv: { token: 'saved' }, revisions: { token: 1 } } },
			})
			const before = await readFile(vaultPath(backend, 'global/state.enc'))
			await using invalid = await setup(backend)
			await expect(
				requireVaultHost(invalid.ctx).forOwner(invalid.ctx).kv().get('token'),
			).rejects.toMatchObject({ code: 'INVALID_FORMAT' })
			expect(await readFile(vaultPath(backend, 'global/state.enc'))).toEqual(before)
		},
	)

	it.each([undefined, {}, { token: 0 }, { token: 1.5 }])(
		'rejects invalid snapshot revisions %j without rewriting storage',
		async (revisions) => {
			const backend = await diskConfig()
			const host = await setup(backend)
			await requireVaultHost(host.ctx).admin.unlock()
			await host.close()
			await replaceSnapshot(backend, {
				kind: 'pluxel.vault.snapshot',
				version: 2,
				namespaces: { default: { kv: { token: 'saved' }, revisions } },
			})
			const before = await readFile(vaultPath(backend, 'global/state.enc'))
			await using invalid = await setup(backend)
			await expect(
				requireVaultHost(invalid.ctx).forOwner(invalid.ctx).kv().get('token'),
			).rejects.toMatchObject({ code: 'INVALID_FORMAT' })
			expect(await readFile(vaultPath(backend, 'global/state.enc'))).toEqual(before)
		},
	)

	it('rekeys only the envelope, reopens with explicit deployment identity and rejects missing or damaged state', async () => {
		const backend = await diskConfig()
		const host = await setup(backend)
		await requireVaultHost(host.ctx).forOwner(host.ctx).kv().set('token', 'secret')
		const before = await readFile(vaultPath(backend, 'global/state.enc'))
		const pair = await requireVaultHost(host.ctx).admin.generateDeployKey()
		await requireVaultHost(host.ctx).admin.setDeployRecipients([pair.publicKey])
		await requireVaultHost(host.ctx).admin.rekey()
		expect(await readFile(vaultPath(backend, 'global/state.enc'))).toEqual(before)
		await host.close()
		await unlink(vaultPath(backend, 'security/identity.json'))
		{
			await using locked = await setup(backend)
			expect(await requireVaultHost(locked.ctx).admin.describe()).toMatchObject({
				present: true,
				unlocked: false,
				hostIdentityPresent: false,
			})
			await expect(
				requireVaultHost(locked.ctx).forOwner(locked.ctx).kv().get('token'),
			).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
			expect(nativeFs.existsSync(vaultPath(backend, 'security/identity.json'))).toBe(false)
		}
		const unlocked = await setup(backend, { deployIdentity: pair.privateKey })
		try {
			expect(
				await requireVaultHost(unlocked.ctx)
					.forOwner(unlocked.ctx)
					.kv()
					.get('token')
					.then((result) => result.value),
			).toBe('secret')
			expect(
				await requireVaultHost(unlocked.ctx)
					.admin.describe()
					.then((result) => result.unlockedBy),
			).toBe('deploy')
		} finally {
			await unlocked.close()
		}
		const original = await readFile(vaultPath(backend, 'global/state.enc'))
		const damaged = new Uint8Array(original)
		damaged[damaged.length - 1] ^= 1
		await writeFile(vaultPath(backend, 'global/state.enc'), damaged)
		{
			await using damagedHost = await setup(backend, { deployIdentity: pair.privateKey })
			await expect(
				requireVaultHost(damagedHost.ctx).forOwner(damagedHost.ctx).kv().get('token'),
			).rejects.toMatchObject({ code: 'DECRYPT_FAILED' })
		}
		expect(new Uint8Array(await readFile(vaultPath(backend, 'global/state.enc')))).toEqual(damaged)
		await unlink(vaultPath(backend, 'global/state.enc'))
		await using missingState = await setup(backend, { deployIdentity: pair.privateKey })
		await expect(
			requireVaultHost(missingState.ctx).forOwner(missingState.ctx).kv().get('token'),
		).rejects.toMatchObject({ code: 'INVALID_FORMAT' })
	})
})
