import { requireFs, requireVaultHost, enterOwnerInvocation } from '@pluxel/core/internal'
import { BasePlugin, Plugin, type Context } from '@pluxel/core'
import { createHost } from '@pluxel/host'
import { afterEach, expect, it, vi } from 'vitest'
import * as nativeFs from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Passthrough } from '@pluxel/core/fs'
import type { VaultStorageApi } from '@pluxel/core/vault'

const directories: string[] = []
afterEach(async () => {
	vi.restoreAllMocks()
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

let ownerContext: Context
let ownerVault: VaultStorageApi
@Plugin()
class VaultOwner extends BasePlugin {
	init() {
		ownerContext = this.ctx
		ownerVault = this.ctx.vault
	}
}

function closingSignal(ctx: Context): AbortSignal {
	const lease = enterOwnerInvocation(ctx)
	lease.dispose()
	return lease.signal
}
function waitForClose(signal: AbortSignal): Promise<void> {
	return signal.aborted
		? Promise.resolve()
		: new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
}

it.each(['root', 'owner'] as const)(
	'drains a first credential read admitted before immediate %s closure',
	async (scope) => {
		const host = await createHost({
			plugins: [{ plugin: VaultOwner }],
			coreConfig: { vault: { backend: 'bindings' } },
		})
		try {
			if (scope === 'owner') await host.startNode(VaultOwner.nodeAddress())
			const retained =
				scope === 'owner' ? ownerVault : requireVaultHost(host.ctx).forOwner(host.ctx)
			const accepted = retained.kv().get('missing')
			const closing = scope === 'root' ? host.close() : host.stopNode(VaultOwner.nodeAddress())
			await expect(accepted).resolves.toMatchObject({ exists: false, writable: false })
			await closing
			await expect(retained.kv().get('stale')).rejects.toThrow('stopped')
		} finally {
			await host.close()
		}
	},
)

it('releases the owner cleanup when a Vault watch is disposed', async () => {
	await using host = await createHost({
		plugins: [{ plugin: VaultOwner }],
		coreConfig: { vault: { backend: 'bindings' } },
	})
	await host.startNode(VaultOwner.nodeAddress())
	using defer = vi.spyOn(ownerContext.effects, 'defer')
	const watched = await ownerVault.kv().watch('record', () => {})
	const registered = defer.mock.results[0]?.value
	expect(registered?.active).toBe(true)
	watched.dispose()
	watched.dispose()
	expect(registered?.active).toBe(false)
})

it('drains an accepted transaction before generation stop and rejects retained KV and blob handles', async () => {
	const host = await createHost({
		plugins: [{ plugin: VaultOwner }],
		services: [],
	})
	const entered = Promise.withResolvers<void>()
	const release = Promise.withResolvers<void>()
	try {
		const owner = VaultOwner.nodeAddress()
		await host.startNode(owner)
		const kv = ownerVault.kv()
		const blob = ownerVault.blobs().open('cached')
		const signal = closingSignal(ownerContext)
		const accepted = kv.batch(async (tx) => {
			tx.set('before', 'accepted')
			entered.resolve()
			await release.promise
			tx.set('after', 'drained')
		})
		await entered.promise
		let stopped = false
		const stop = host.stopNode(owner).then((): void => {
			stopped = true
			return undefined
		})
		await waitForClose(signal)
		expect(stopped).toBe(false)
		await expect(kv.set('stale', true)).rejects.toThrow('stopped')
		await expect(blob.remove()).rejects.toThrow('stopped')
		await expect(ownerVault.flush()).rejects.toThrow('stopped')
		release.resolve()
		await accepted
		await stop
		await host.startNode(owner)
		expect(
			await ownerVault
				.kv()
				.get('before')
				.then((result) => result.value),
		).toBe('accepted')
		expect(
			await ownerVault
				.kv()
				.get('after')
				.then((result) => result.value),
		).toBe('drained')
	} finally {
		release.resolve()
		await host.close()
	}
})

it('keeps complete blob IO admitted through Host close, then flushes the final snapshot and rejects stale root handles', async () => {
	const prefix = await mkdtemp(join(tmpdir(), 'pluxel-vault-lifetime-'))
	directories.push(prefix)
	const entered = Promise.withResolvers<void>()
	const release = Promise.withResolvers<void>()
	const events: string[] = []
	const config = {
		zenfs: {
			mounts: { '/': { backend: Passthrough, fs: nativeFs, prefix } },
			durableMounts: ['/'],
		},
	}
	const host = await createHost({ plugins: [], services: [], coreConfig: { ...config } })
	const directory = await requireFs(host.ctx).directory('services/vault')
	const rename = directory.rename
	vi.spyOn(directory, 'rename').mockImplementation(async (from, to) => {
		if (String(to).endsWith('.blob')) {
			entered.resolve()
			await release.promise
			await Reflect.apply(rename, directory, [from, to])
			events.push('blob completed')
		} else {
			await Reflect.apply(rename, directory, [from, to])
			if (String(to).endsWith('state.enc')) events.push('snapshot flushed')
		}
	})
	const rootVault = requireVaultHost(host.ctx).forOwner(host.ctx)
	const blob = rootVault.blobs().open('root-blob')
	try {
		await rootVault.kv().set('final', 'persisted')
		events.length = 0
		const signal = closingSignal(host.ctx)
		const accepted = blob.writeText('payload')
		await entered.promise
		let closed = false
		const closing = host.close().then((): void => {
			closed = true
			return undefined
		})
		await waitForClose(signal)
		expect(closed).toBe(false)
		await expect(blob.writeText('stale')).rejects.toThrow('stopped')
		release.resolve()
		await accepted
		await closing
		expect(events).toEqual(['blob completed'])
	} finally {
		release.resolve()
		await host.close()
	}
	const reopened = await createHost({ plugins: [], services: [], coreConfig: { ...config } })
	try {
		const storage = requireVaultHost(reopened.ctx).forOwner(reopened.ctx)
		await expect(storage.kv().get('final')).resolves.toMatchObject({ value: 'persisted' })
		await expect(storage.blobs().open('root-blob').readText()).resolves.toBe('payload')
	} finally {
		await reopened.close()
	}
})
