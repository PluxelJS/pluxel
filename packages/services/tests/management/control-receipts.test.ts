import { BasePlugin, Plugin } from '@pluxel/core'
import { createHost, type HostDocumentStorage } from '@pluxel/host'
import { RpcStub } from 'capnweb'
import { expect, it } from 'vitest'
import { managementAccess } from '../../src/management/access'
import { createRuntimeManagementClient } from '../../src/management/client'
import { createHostManagementTarget, management } from '../../src/management/service'

let duringStart: (() => Promise<void>) | undefined

@Plugin()
class Publisher extends BasePlugin {
	async init() {
		await duringStart?.()
	}
}

@Plugin()
class Subscriber extends BasePlugin {}

const address = Publisher.nodeAddress()
const start = { address, command: 'start' } as const
const stop = { address, command: 'stop' } as const

async function launch(storage?: HostDocumentStorage) {
	const host = await createHost({
		plugins: [{ plugin: Publisher }, { plugin: Subscriber }],
		policy: { document: storage ? { storage: () => storage } : false },
		services: [managementAccess(), management()],
	})
	try {
		await host.start()
		return host
	} catch (error) {
		await host.close()
		throw error
	}
}

it('keeps the start receipt tied to its own commit when a later stop and restart are waiting', async () => {
	await using host = await launch()
	using remote = new RpcStub(createHostManagementTarget(host.ctx))
	const client = createRuntimeManagementClient(remote)
	const entered = Promise.withResolvers<void>()
	const finish = Promise.withResolvers<void>()
	duringStart = () => {
		entered.resolve()
		return finish.promise
	}
	try {
		const starting = client.plugins.applyLifecycleCommands([start])
		await entered.promise
		const stopping = client.plugins.applyLifecycleCommands([stop, { address, command: 'restart' }])
		finish.resolve()
		expect(await starting).toMatchObject({
			ok: true,
			results: [{ control: { lifecycleState: 'running' } }],
		})
		expect(await stopping).toMatchObject({
			ok: false,
			status: 'partially-applied',
			results: [
				{ ok: true, control: { lifecycleState: 'stopped' } },
				{ ok: false, code: 'restart_unavailable', state: 'unchanged' },
			],
		})
		expect(await client.plugins.status(address)).toMatchObject({
			value: { lifecycleState: 'stopped' },
		})
	} finally {
		finish.resolve()
		duringStart = undefined
	}
})

it('lets an admitted start finish when the caller disconnects and drops the next item', async () => {
	await using host = await launch()
	const session = new AbortController()
	using cancelled = new RpcStub(createHostManagementTarget(host.ctx, { signal: session.signal }))
	using connected = new RpcStub(createHostManagementTarget(host.ctx))
	const entered = Promise.withResolvers<void>()
	const finish = Promise.withResolvers<void>()
	duringStart = () => {
		entered.resolve()
		return finish.promise
	}
	try {
		const request = createRuntimeManagementClient(cancelled).plugins.applyLifecycleCommands([
			start,
			stop,
		])
		const rejected = request.catch((error: unknown) => error)
		await entered.promise
		session.abort(new Error('Management session ended'))
		finish.resolve()
		expect(await rejected).toMatchObject({ message: 'Management session ended' })
		const client = createRuntimeManagementClient(connected)
		expect(await client.plugins.status(address)).toMatchObject({
			value: { lifecycleState: 'running' },
		})
	} finally {
		finish.resolve()
		duringStart = undefined
	}
})

it('reports an unknown batch outcome and keeps an earlier confirmed write visible', async () => {
	let saved: string | undefined
	let writes = 0
	await using host = await launch({
		async getText() {
			return saved
		},
		async stat() {
			return saved === undefined ? undefined : {}
		},
		async put(_key, text) {
			if (++writes > 1) throw new Error('write acknowledgement unavailable')
			saved = text
		},
	})
	using remote = new RpcStub(createHostManagementTarget(host.ctx))
	const client = createRuntimeManagementClient(remote)
	const second = Subscriber.nodeAddress()
	const receipt = await client.plugins.setAutoStart(
		[address, second].map((owner) => ({ address: owner, autoStart: true })),
	)
	expect(receipt).toMatchObject({
		ok: false,
		status: 'unknown',
		results: [
			{ address, ok: true, control: { autoStart: true } },
			{ address: second, ok: false, code: 'persistence_failed', state: 'unknown' },
		],
	})
	expect(await client.policy.get()).toMatchObject({ effective: { autoStart: [address] } })
})

it('rejects an invalid item before applying the valid prefix of the batch', async () => {
	await using host = await launch()
	using remote = new RpcStub(createHostManagementTarget(host.ctx))
	const client = createRuntimeManagementClient(remote)
	const malformed = { address: Subscriber.nodeAddress(), command: 'enable' } as never
	const rejected = {
		ok: false,
		status: 'rejected',
		code: 'invalid_input',
		state: 'unchanged',
		results: [] as const,
	}
	expect(await client.plugins.applyLifecycleCommands([start, malformed])).toMatchObject(rejected)
	const policy = await client.policy.get()
	expect(
		await client.plugins.setAutoStart([{ address, autoStart: true }], {
			expectedManagedRevision: 42 as never,
		}),
	).toMatchObject(rejected)
	expect(await client.policy.get()).toEqual(policy)
	expect(await client.plugins.status(address)).toMatchObject({
		value: { lifecycleState: 'stopped', sessionIntent: 'inherit' },
	})
})

it('returns a stopped receipt as the last reference to a removed plugin disappears', async () => {
	await using host = await createHost({
		plugins: [],
		services: [managementAccess(), management()],
		policy: { document: false },
	})
	await host.updateCatalog([Publisher, Subscriber])
	using remote = new RpcStub(createHostManagementTarget(host.ctx))
	const client = createRuntimeManagementClient(remote)
	await client.plugins.applyLifecycleCommands([start])
	await host.updateCatalog([Subscriber])
	expect(await client.plugins.status(address)).toMatchObject({
		value: { availability: 'unavailable' },
	})
	expect(await client.plugins.applyLifecycleCommands([start])).toMatchObject({
		ok: false,
		results: [{ code: 'start_unavailable', state: 'unchanged' }],
	})
	expect(await client.plugins.applyLifecycleCommands([stop])).toMatchObject({
		ok: true,
		results: [{ control: { sessionIntent: 'inherit', lifecycleState: 'stopped' } }],
	})
	expect(await client.plugins.status(address)).toEqual({ ok: true, value: null })
})

it('can start a plugin while its presentation extension fails', async () => {
	await using host = await createHost({
		plugins: [{ plugin: Publisher }],
		services: [
			managementAccess(),
			management({
				recentUpdate: {
					resolveRecentUpdate() {
						throw new Error('update presentation unavailable')
					},
				},
			}),
		],
		policy: { document: false },
	})
	await host.start()
	using remote = new RpcStub(createHostManagementTarget(host.ctx))
	const client = createRuntimeManagementClient(remote)
	await expect(client.plugins.status(address)).rejects.toThrow('update presentation unavailable')
	expect(await client.plugins.applyLifecycleCommands([start])).toMatchObject({
		ok: true,
		results: [{ control: { lifecycleState: 'running' } }],
	})
})
