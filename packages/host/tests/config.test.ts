import { createDocumentStorage } from './helpers/document-storage'
import { BasePlugin, Plugin, pluginNodeAddressOf } from '@pluxel/core'
import { expect, it } from 'vitest'
import { createHost } from '../src/index'

const schema = {
	'~standard': {
		version: 1 as const,
		vendor: 'host-test',
		types: undefined as { input: Record<string, unknown>; output: { value: string } } | undefined,
		validate(input: unknown) {
			const value = (input as { value?: unknown })?.value ?? 'initial'
			return typeof value === 'string'
				? { value: { value } }
				: { issues: [{ message: 'value must be a string', path: ['value'] }] }
		},
	},
}
const updates: string[] = []
@Plugin()
class ConfigOwner extends BasePlugin {
	readonly config = this.configs.use(schema)
	init() {
		this.configs.onUpdate(this.config, ({ desired }) => {
			updates.push(desired.value)
		})
	}
}

it('shares one config authority for validation, deferred writes, running notification, reset and closed admission', async () => {
	const host = await createHost({ plugins: [ConfigOwner] })
	const owner = pluginNodeAddressOf(ConfigOwner)
	try {
		await expect(host.config.validate(owner, { value: 42 })).resolves.toMatchObject({
			ok: false,
			code: 'validation_failed',
			state: 'unchanged',
		})
		await expect(host.config.get(owner)).resolves.toMatchObject({
			ok: true,
			saved: false,
			application: 'deferred',
			config: {},
			defaults: {},
		})
		await expect(host.config.patch(owner, { value: 'saved' })).resolves.toMatchObject({
			ok: true,
			saved: true,
			application: 'deferred',
			config: { value: 'saved' },
		})
		await host.startNode(owner)
		const running = await host.config.get(owner)
		expect(running).toMatchObject({ ok: true, application: 'applied' })
		if (running.ok === false) throw new Error(running.message)
		expect(running.appliedRevision).toBe(running.desiredRevision)
		await expect(host.config.patch(owner, { value: 'updated' })).resolves.toMatchObject({
			ok: true,
			application: 'applied',
			config: { value: 'updated' },
		})
		await expect(host.config.reset(owner)).resolves.toMatchObject({
			ok: true,
			application: 'applied',
			config: { value: 'initial' },
		})
		expect(updates).toEqual(['updated', 'initial'])
		await host.updateCatalog([])
		await expect(host.config.patch(owner, { value: 'orphan' })).resolves.toMatchObject({
			ok: false,
			code: 'node_unavailable',
		})
	} finally {
		await host.close()
	}
	await expect(host.config.get(owner)).rejects.toThrow('closed')
})

it('prepares explicit config and state documents, reopens stored values ahead of seeds, and borrows backends', async () => {
	const configStorage = createDocumentStorage()
	const stateStorage = createDocumentStorage()
	let backendClosed = false
	const borrowed = {
		...configStorage,
		close() {
			backendClosed = true
		},
	}
	const owner = pluginNodeAddressOf(ConfigOwner)
	const host = await createHost({
		plugins: [ConfigOwner],
		state: { storage: stateStorage, initial: { autoStart: [owner] } },
		configRecords: { storage: borrowed, initial: [{ owner, config: { value: 'seed' } }] },
	})
	try {
		await expect(host.config.get(owner)).resolves.toMatchObject({
			ok: true,
			application: 'applied',
			config: { value: 'seed' },
		})
		await host.config.patch(owner, { value: 'persisted' })
	} finally {
		await host.close()
	}
	const reopened = await createHost({
		plugins: [ConfigOwner],
		state: { storage: stateStorage, initial: { autoStart: [] } },
		configRecords: { storage: borrowed, initial: [{ owner, config: { value: 'ignored seed' } }] },
	})
	try {
		await expect(reopened.config.get(owner)).resolves.toMatchObject({
			ok: true,
			application: 'applied',
			config: { value: 'persisted' },
		})
	} finally {
		await reopened.close()
	}
	expect(backendClosed).toBe(false)
})

it('rejects canceled queued writes while allowing an already admitted operation to settle', async () => {
	const { requirePluginHostCoordinator } = await import('../src/internal')
	const { pluginConfigPatch } = await import('../src/config')
	const host = await createHost({ plugins: [ConfigOwner] })
	const started = Promise.withResolvers<void>()
	const release = Promise.withResolvers<void>()
	const admittedSignal = new AbortController()
	const queuedSignal = new AbortController()
	try {
		await host.start()
		const coordinator = requirePluginHostCoordinator(host.ctx)
		const admitted = coordinator.runExclusive(
			'accepted',
			async () => {
				started.resolve()
				await release.promise
				return 42
			},
			{ signal: admittedSignal.signal },
		)
		await started.promise
		const queued = pluginConfigPatch(
			host.ctx,
			pluginNodeAddressOf(ConfigOwner),
			{ value: 'canceled' },
			{ signal: queuedSignal.signal },
		)
		queuedSignal.abort()
		admittedSignal.abort()
		release.resolve()
		expect(await admitted).toBe(42)
		await expect(queued).rejects.toMatchObject({ name: 'AbortError' })
		expect(await host.config.get(pluginNodeAddressOf(ConfigOwner))).toMatchObject({
			ok: true,
			config: {},
		})
	} finally {
		release.resolve()
		await host.close()
	}
})
