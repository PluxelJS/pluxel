import { BasePlugin, Plugin } from '@pluxel/core'
import { setImmediate } from 'node:timers/promises'
import type { Store } from 'tinybase'
import { expect, it, vi } from 'vitest'
import { snapshotCoreFacilities } from '../../src/context/core-facilities'
import {
	consumePluginDefinitionCandidate,
	createCoreContextHostWithFacilities,
	requirePluginService,
	requireTinyBaseHost,
} from '../../src/internal'
import type { CoreDocumentStorage } from '../../src/storage/documents'
import { encodeSnapshot } from '../../src/tinybase/codec'

@Plugin()
class PushOwner extends BasePlugin {
	store!: Store
	protected override async init() {
		this.store = await this.ctx.tinybase.open()
	}
}

const node = PushOwner.nodeAddress()
function snapshot(title: string) {
	return encodeSnapshot({ kind: 'plugin', node }, [{}, { title }], 4000)
}

async function start(documents: CoreDocumentStorage) {
	const facilities = snapshotCoreFacilities(
		{},
		() => () => ({
			documents: { documents: () => documents, documentRetention: () => 'session' },
		}),
		undefined,
	)
	const root = createCoreContextHostWithFacilities({}, facilities).createRoot()
	const registry = requirePluginService(root)
	const add = registry.beginUpdate()
	add.materializeNode(node, consumePluginDefinitionCandidate(PushOwner))
	async function stop() {
		const remove = registry.beginUpdate()
		remove.dematerializeNode(node)
		expect(await remove.commit()).toMatchObject({ ok: true })
	}
	try {
		expect(await add.commit()).toMatchObject({ ok: true })
		const owner = registry.getInstance(node) as PushOwner
		expect(owner).toBeInstanceOf(PushOwner)
		return {
			owner,
			status: () => requireTinyBaseHost(root).status(),
			stop,
			async [Symbol.asyncDispose]() {
				try {
					if (registry.isMaterialized(node)) await stop()
				} finally {
					await root.effects.dispose()
				}
			},
		}
	} catch (error) {
		await root.effects.dispose()
		throw error
	}
}

it('rereads an invalidated push document after a transaction or write settles, and drains reads on stop', async () => {
	let text = snapshot('original')
	let notify!: () => void
	const unsubscribed = Promise.withResolvers<void>()
	const getText = vi.fn(async () => text)
	const put = vi.fn(async (_key: string, value: string) => {
		text = value
	})
	await using host = await start({
		getText,
		put,
		stat: async () => ({}),
		subscribe(listener) {
			notify = listener
			return unsubscribed.resolve
		},
	})
	const { store } = host.owner
	store.startTransaction()
	text = snapshot('external during transaction')
	notify()
	expect(store.getValue('title')).toBe('original')
	store.finishTransaction()
	await expect.poll(() => store.getValue('title')).toBe('external during transaction')

	const writing = Promise.withResolvers<void>()
	const confirm = Promise.withResolvers<void>()
	put.mockImplementationOnce(async (_key, value) => {
		text = value
		writing.resolve()
		await confirm.promise
	})
	store.setValue('title', 'local')
	const commit = host.owner.ctx.tinybase.flush()
	try {
		await writing.promise
		text = snapshot('external after local commit')
		notify()
		expect(store.getValue('title')).toBe('local')
	} finally {
		confirm.resolve()
	}
	await commit
	await expect.poll(() => store.getValue('title')).toBe('external after local commit')

	// One notification can be followed by a transient read failure with unchanged bytes.
	getText.mockRejectedValueOnce(new Error('temporarily unavailable'))
	notify()
	await expect.poll(() => host.status()[0]?.error).toBeInstanceOf(Error)
	await expect.poll(() => host.status()[0]?.error).toBeUndefined()

	const reading = Promise.withResolvers<void>()
	const late = Promise.withResolvers<string>()
	getText.mockImplementationOnce(() => {
		reading.resolve()
		return late.promise
	})
	notify()
	await reading.promise
	let released = false
	const stopped = host.stop().then((): undefined => {
		released = true
		return undefined
	})
	try {
		await unsubscribed.promise
		await setImmediate()
		expect(released).toBe(false)
	} finally {
		late.resolve(snapshot('retired'))
	}
	await stopped
	expect(store.getValue('title')).toBe('external after local commit')
})

it('retains the committed plugin and reports a failed subscription without losing subsequent saves', async () => {
	const error = new Error('change feed unavailable')
	const put = vi.fn(async () => {})
	await using host = await start({
		getText: async () => snapshot('restored'),
		put,
		stat: async () => ({}),
		subscribe() {
			throw error
		},
	})
	expect(host.status()).toMatchObject([{ phase: 'active', error }])
	host.owner.store.setValue('title', 'saved')
	await host.owner.ctx.tinybase.flush()
	expect(put).toHaveBeenLastCalledWith(expect.any(String), snapshot('saved'))
})
