import { BasePlugin, Plugin, pluginNodeAddressOf, type Context } from '@pluxel/core'
import { enterOwnerInvocation } from '@pluxel/core/internal'
import { createHost } from '@pluxel/host'
import { expect, it } from 'vitest'
import {
	createMemoryPersistenceBackend,
	persistence,
	type PersistenceBackend,
} from '../src/persistence'
import { Vault, vault, type VaultStorageApi } from '../src/vault'

let ownerContext: Context
let ownerVault: VaultStorageApi
@Plugin()
class VaultOwner extends BasePlugin {
	init() {
		ownerContext = this.ctx
		ownerVault = this.ctx.require(Vault)
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

it('drains an accepted transaction before generation stop and rejects retained KV and blob handles', async () => {
	const host = await createHost({
		plugins: [VaultOwner],
		services: [persistence({ mode: 'memory' }), vault()],
	})
	const entered = Promise.withResolvers<void>()
	const release = Promise.withResolvers<void>()
	try {
		const owner = pluginNodeAddressOf(VaultOwner)
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
	const memory = createMemoryPersistenceBackend()
	const entered = Promise.withResolvers<void>()
	const release = Promise.withResolvers<void>()
	const events: string[] = []
	let blockBlob = true
	const backend: PersistenceBackend = {
		capability: memory.capability,
		namespace(name) {
			const storage = memory.namespace(name)
			return {
				...storage,
				async put(key, value, options) {
					if (key.endsWith('.blob') && blockBlob) {
						entered.resolve()
						await release.promise
						events.push('blob completed')
					} else if (key.endsWith('state.enc')) events.push('snapshot flushed')
					await storage.put(key, value, options)
				},
			}
		},
	}
	const services = [persistence({ mode: 'custom', backend }), vault()]
	const host = await createHost({ plugins: [], services })
	const rootVault = host.ctx.require(Vault)
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
	blockBlob = false
	const reopened = await createHost({ plugins: [], services })
	try {
		const storage = reopened.ctx.require(Vault)
		await expect(storage.kv().get('final')).resolves.toMatchObject({ value: 'persisted' })
		await expect(storage.blobs().open('root-blob').readText()).resolves.toBe('payload')
	} finally {
		await reopened.close()
	}
})
