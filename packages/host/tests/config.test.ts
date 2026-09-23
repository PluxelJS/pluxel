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

const layeredUpdates: unknown[] = []
const layeredSchema: import('@standard-schema/spec').StandardSchemaV1<
	Record<string, unknown>,
	Record<string, unknown>
> = {
	'~standard': {
		version: 1 as const,
		vendor: 'host-layers-test',
		validate(input: unknown) {
			return { value: input as Record<string, unknown> }
		},
	},
}
@Plugin()
class LayeredOwner extends BasePlugin {
	readonly config = this.configs.use(layeredSchema)
	init() {
		this.configs.onUpdate(this.config, ({ desired }) => {
			layeredUpdates.push(desired)
		})
	}
}

it('resolves base < saved < env, persists only management edits, and reveals lower values after removing env', async () => {
	const { SuperJSON } = await import('superjson')
	const storage = createDocumentStorage()
	const owner = pluginNodeAddressOf(LayeredOwner)
	await storage.put(
		'config.json',
		SuperJSON.stringify({
			version: 3,
			plugins: [
				{ owner, config: { nested: { endpoint: 'saved-endpoint', count: 2 }, list: ['saved'] } },
			],
		}),
	)
	const initial = [
		{
			owner,
			config: {
				nested: { endpoint: 'base-endpoint', count: 1, keep: true },
				list: ['base'],
				baseOnly: true,
			},
		},
	]
	const host = await createHost({
		plugins: [LayeredOwner],
		configRecords: {
			storage,
			initial,
			overlays: [
				{
					owner,
					config: { nested: { endpoint: 'env-endpoint' }, list: ['env'] },
					sources: [
						{ path: ['nested', 'endpoint'], kind: 'env', name: 'APP_ENDPOINT' },
						{ path: ['list'], kind: 'env', name: 'APP_LIST' },
					],
				},
			],
		},
	})
	try {
		await host.startNode(owner)
		const result = await host.config.get(owner)
		expect(result).toMatchObject({
			ok: true,
			config: {
				nested: { endpoint: 'env-endpoint', count: 2, keep: true },
				list: ['env'],
				baseOnly: true,
			},
		})
		if (result.ok === false) throw new Error(result.message)
		expect(result.sources).toContainEqual({
			owner,
			path: ['nested', 'endpoint'],
			kind: 'env',
			name: 'APP_ENDPOINT',
			readonly: true,
		})
		expect(JSON.stringify(result.sources)).not.toContain('env-endpoint')
		await expect(host.config.patch(owner, { nested: { count: 3 } })).resolves.toMatchObject({
			ok: true,
			application: 'applied',
			config: { nested: { endpoint: 'env-endpoint', count: 3, keep: true } },
		})
		const persisted = SuperJSON.parse(await storage.getText('config.json')!) as {
			plugins: { config: unknown }[]
		}
		expect(persisted.plugins[0]?.config).toEqual({
			nested: { endpoint: 'saved-endpoint', count: 3 },
			list: ['saved'],
		})
	} finally {
		await host.close()
	}
	const reopened = await createHost({
		plugins: [LayeredOwner],
		configRecords: { storage, initial },
	})
	try {
		await expect(reopened.config.get(owner)).resolves.toMatchObject({
			ok: true,
			config: { nested: { endpoint: 'saved-endpoint', count: 3, keep: true }, list: ['saved'] },
		})
		await expect(reopened.config.reset(owner, ['nested'])).resolves.toMatchObject({
			ok: true,
			config: { nested: { endpoint: 'base-endpoint', count: 1, keep: true } },
		})
	} finally {
		await reopened.close()
	}
})

it('rejects env-controlled patch/reset parent and child paths, including same-value and low-level writes', async () => {
	const { requireConfigService } = await import('@pluxel/core/internal')
	const { mutatePluginConfig } = await import('../src/config')
	const owner = pluginNodeAddressOf(LayeredOwner)
	const host = await createHost({
		plugins: [LayeredOwner],
		configRecords: {
			overlays: [
				{
					owner,
					config: { nested: { locked: { value: 'env' } } },
					sources: [{ path: ['nested', 'locked'], kind: 'env', name: 'APP_LOCKED' }],
				},
			],
		},
	})
	try {
		for (const patch of [
			{ nested: null },
			{ nested: { locked: { value: 'changed' } } },
			{ nested: { locked: { value: 'env' } } },
		]) {
			await expect(host.config.patch(owner, patch)).resolves.toMatchObject({
				ok: false,
				code: 'mutation_rejected',
			})
			await expect(host.config.validate(owner, patch)).resolves.toMatchObject({
				ok: false,
				code: 'mutation_rejected',
			})
		}
		await expect(host.config.reset(owner)).resolves.toMatchObject({
			ok: false,
			code: 'mutation_rejected',
		})
		await expect(host.config.reset(owner, ['nested'])).resolves.toMatchObject({
			ok: false,
			code: 'mutation_rejected',
		})
		await expect(
			mutatePluginConfig(host.ctx, owner, 'field-write', () => ({ nested: {} }), undefined, [
				['nested'],
			]),
		).resolves.toMatchObject({ ok: false, code: 'mutation_rejected' })
		const service = requireConfigService(host.ctx)
		expect(() => service.patchConfig(owner, { nested: { locked: { value: 'env' } } })).toThrow(
			/environment-controlled/,
		)
		expect(() => service.unsetConfigKeys(owner, ['nested'])).toThrow(/environment-controlled/)
		expect(() => service.deleteConfig(owner)).toThrow(/environment-controlled/)
		expect(() =>
			service.stageValidatedConfig({
				owner,
				authority: { schema: layeredSchema },
				expectedRevision: service.getConfigRevision(owner),
				value: {},
			}),
		).toThrow(/environment-controlled/)
		await expect(host.config.patch(owner, { nested: { editable: true } })).resolves.toMatchObject({
			ok: true,
		})
	} finally {
		await host.close()
	}
})

it('keeps the confirmed revision and generation unchanged when layered persistence fails', async () => {
	const { requireConfigService } = await import('@pluxel/core/internal')
	const memory = createDocumentStorage()
	let fail = false
	const storage = {
		...memory,
		async put(...args: Parameters<typeof memory.put>) {
			if (fail) throw new Error('write failed')
			await memory.put(...args)
		},
	}
	const owner = pluginNodeAddressOf(LayeredOwner)
	const host = await createHost({
		plugins: [LayeredOwner],
		configRecords: { storage, initial: [{ owner, config: { value: 'base' } }] },
	})
	try {
		await host.startNode(owner)
		const service = requireConfigService(host.ctx)
		const before = service.getRawConfig(owner)
		const revision = service.getConfigRevision(owner)
		const notifications = layeredUpdates.length
		fail = true
		await expect(host.config.patch(owner, { value: 'candidate' })).resolves.toMatchObject({
			ok: false,
			code: 'persistence_failed',
			config: { value: 'base' },
		})
		expect(service.getRawConfig(owner)).toBe(before)
		expect(service.getConfigRevision(owner)).toBe(revision)
		expect(layeredUpdates.length).toBe(notifications)
		fail = false
		await expect(host.config.patch(owner, { value: 'retry' })).resolves.toMatchObject({
			ok: true,
			application: 'applied',
		})
	} finally {
		fail = false
		await host.close()
	}
})
