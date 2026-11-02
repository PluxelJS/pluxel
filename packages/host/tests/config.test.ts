import { createDocumentStorage } from './helpers/document-storage'
import { BasePlugin, Plugin } from '@pluxel/core'
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
	const owner = ConfigOwner.nodeAddress()
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
	const owner = ConfigOwner.nodeAddress()
	const host = await createHost({
		plugins: [ConfigOwner],
		runtime: {
			state: { storage: () => stateStorage, autoStart: [owner] },
			configRecords: {
				storage: () => borrowed,
				records: [{ owner, config: { value: 'seed' } }],
			},
		},
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
		runtime: {
			state: { storage: () => stateStorage, autoStart: [] },
			configRecords: {
				storage: () => borrowed,
				records: [{ owner, config: { value: 'ignored seed' } }],
			},
		},
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

it.each(['config', 'state'] as const)(
	'rejects Host preparation when persisted %s is invalid and preserves both documents',
	async (broken) => {
		const configStorage = createDocumentStorage()
		const stateStorage = createDocumentStorage()
		const validConfig = JSON.stringify({ version: 4, plugins: [] })
		const validState = JSON.stringify({
			version: 6,
			autoStart: [],
			forks: [],
			providerDefaults: [],
			dependencyOverrides: [],
		})
		await configStorage.put('config.json', broken === 'config' ? '{' : validConfig)
		await stateStorage.put('state.json', broken === 'state' ? '{' : validState)
		await expect(
			createHost({
				plugins: [],
				runtime: {
					configRecords: { storage: () => configStorage },
					state: { storage: () => stateStorage },
				},
			}),
		).rejects.toThrow(/Cannot load (config|state)\.json/)
		expect(await configStorage.getText('config.json')).toBe(broken === 'config' ? '{' : validConfig)
		expect(await stateStorage.getText('state.json')).toBe(broken === 'state' ? '{' : validState)
		expect([...configStorage.documents.keys()]).toEqual(['config.json'])
		expect([...stateStorage.documents.keys()]).toEqual(['state.json'])
	},
)

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
			ConfigOwner.nodeAddress(),
			{ value: 'canceled' },
			{ signal: queuedSignal.signal },
		)
		queuedSignal.abort()
		admittedSignal.abort()
		release.resolve()
		expect(await admitted).toBe(42)
		await expect(queued).rejects.toMatchObject({ name: 'AbortError' })
		expect(await host.config.get(ConfigOwner.nodeAddress())).toMatchObject({
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

it('loads whole saved records beneath env and restores declarations only on explicit reset', async () => {
	const { SuperJSON } = await import('superjson')
	const storage = createDocumentStorage()
	const owner = LayeredOwner.nodeAddress()
	await storage.put(
		'config.json',
		SuperJSON.stringify({
			version: 4,
			plugins: [
				{ owner, config: { nested: { endpoint: 'saved-endpoint', count: 2 }, list: ['saved'] } },
			],
		}),
	)
	const records = [
		{
			owner,
			config: {
				nested: { endpoint: 'base-endpoint', count: 1, keep: true },
				list: ['base'],
			},
		},
	]
	const host = await createHost({
		plugins: [LayeredOwner],
		runtime: {
			configRecords: {
				storage: () => storage,
				records,
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
		},
	})
	try {
		await host.startNode(owner)
		const result = await host.config.get(owner)
		expect(result).toMatchObject({
			ok: true,
			config: {
				nested: { endpoint: 'env-endpoint', count: 2 },
				list: ['env'],
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
			config: { nested: { endpoint: 'env-endpoint', count: 3 } },
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
		runtime: { configRecords: { storage: () => storage, records } },
	})
	try {
		await expect(reopened.config.get(owner)).resolves.toMatchObject({
			ok: true,
			config: { nested: { endpoint: 'saved-endpoint', count: 3 }, list: ['saved'] },
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
	const owner = LayeredOwner.nodeAddress()
	const host = await createHost({
		plugins: [LayeredOwner],
		runtime: {
			configRecords: {
				overlays: [
					{
						owner,
						config: { nested: { locked: { value: 'env' } } },
						sources: [{ path: ['nested', 'locked'], kind: 'env', name: 'APP_LOCKED' }],
					},
				],
			},
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
	const owner = LayeredOwner.nodeAddress()
	const host = await createHost({
		plugins: [LayeredOwner],
		runtime: {
			configRecords: {
				storage: () => storage,
				records: [{ owner, config: { value: 'base' } }],
			},
		},
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

it('keeps saved raw 200 behind declaration override 100 when editing another field, and reveals 200 after reopening', async () => {
	const { SuperJSON } = await import('superjson')
	const storage = createDocumentStorage()
	const owner = LayeredOwner.nodeAddress()
	const raw = [
		{
			owner,
			config: {
				limit: 200,
				nested: { locked: 2, editable: 3 },
				list: [1, 2],
				empty: 'retained',
				other: 'before',
			},
		},
	]
	await storage.put('config.json', SuperJSON.stringify({ version: 4, plugins: raw }))
	const records = [
		{ owner, config: { limit: 100, nested: { locked: 1 }, list: [] as number[], empty: {} } },
	]
	const host = await createHost({
		plugins: [LayeredOwner],
		runtime: { configRecords: { records, override: true, storage: () => storage } },
	})
	try {
		await host.startNode(owner)
		await expect(host.config.get(owner)).resolves.toMatchObject({
			config: { limit: 100, nested: { locked: 1, editable: 3 }, list: [], empty: 'retained' },
		})
		for (const patch of [
			{ limit: 100 },
			{ nested: null },
			{ nested: { locked: 1 } },
			{ list: [] as number[] },
		]) {
			await expect(host.config.patch(owner, patch)).resolves.toMatchObject({
				ok: false,
				code: 'mutation_rejected',
			})
		}
		await expect(host.config.reset(owner, ['limit'])).resolves.toMatchObject({
			ok: false,
			code: 'mutation_rejected',
		})
		await expect(host.config.reset(owner)).resolves.toMatchObject({
			ok: false,
			code: 'mutation_rejected',
		})
		await expect(
			host.config.patch(owner, { other: 'after', nested: { editable: 4 }, empty: 'editable' }),
		).resolves.toMatchObject({ ok: true, application: 'applied' })
		expect(SuperJSON.parse((await storage.getText('config.json'))!)).toEqual({
			version: 4,
			plugins: [
				{
					owner,
					config: {
						limit: 200,
						nested: { locked: 2, editable: 4 },
						list: [1, 2],
						empty: 'editable',
						other: 'after',
					},
				},
			],
		})
	} finally {
		await host.close()
	}
	const reopened = await createHost({
		plugins: [LayeredOwner],
		runtime: { configRecords: { records, storage: () => storage } },
	})
	try {
		await expect(reopened.config.get(owner)).resolves.toMatchObject({
			config: { limit: 200, nested: { locked: 2, editable: 4 }, list: [1, 2], other: 'after' },
		})
	} finally {
		await reopened.close()
	}
})

it('resets to current raw declarations, deletes undeclared saved keys, and treats empty reset keys as no work', async () => {
	const { SuperJSON } = await import('superjson')
	const storage = createDocumentStorage()
	const owner = LayeredOwner.nodeAddress()
	await storage.put(
		'config.json',
		SuperJSON.stringify({
			version: 4,
			plugins: [{ owner, config: { value: 200, removed: true, untouched: 'saved' } }],
		}),
	)
	const host = await createHost({
		plugins: [LayeredOwner],
		runtime: {
			configRecords: {
				records: [{ owner, config: { value: 100, declaredOnly: true } }],
				storage: () => storage,
			},
		},
	})
	try {
		await host.startNode(owner)
		const before = await host.config.get(owner)
		const saved = await storage.getText('config.json')
		const notifications = layeredUpdates.length
		expect(await host.config.reset(owner, [])).toEqual(before)
		expect(await storage.getText('config.json')).toBe(saved)
		expect(layeredUpdates.length).toBe(notifications)
		await expect(host.config.reset(owner, ['value', 'removed'])).resolves.toMatchObject({
			config: { value: 100, untouched: 'saved' },
		})
		expect(SuperJSON.parse((await storage.getText('config.json'))!)).toEqual({
			version: 4,
			plugins: [{ owner, config: { value: 100, untouched: 'saved' } }],
		})
		await host.config.reset(owner)
		expect(SuperJSON.parse((await storage.getText('config.json'))!)).toEqual({
			version: 4,
			plugins: [{ owner, config: { value: 100, declaredOnly: true } }],
		})
	} finally {
		await host.close()
	}
})

const normalizedSchema: import('@standard-schema/spec').StandardSchemaV1<
	Record<string, unknown>,
	Record<string, unknown>
> = {
	'~standard': {
		version: 1 as const,
		vendor: 'raw-record-test',
		validate(input: unknown) {
			const raw = input as { raw?: unknown; editable?: unknown }
			if (typeof raw.raw !== 'string')
				return { issues: [{ message: 'raw input must remain a string' }] }
			return {
				value: {
					normalized: Number(raw.raw),
					editable: raw.editable ?? false,
					schemaDefault: 'output only',
				},
			}
		},
	},
}
@Plugin()
class NormalizedOwner extends BasePlugin {
	readonly config = this.configs.use(normalizedSchema)
	init() {
		this.configs.onUpdate(this.config, () => {})
	}
}

it('initializes and saves raw declaration inputs without persisting schema output or environment values', async () => {
	const { SuperJSON } = await import('superjson')
	const memory = createDocumentStorage()
	let writes = 0
	const storage = {
		...memory,
		async put(key: string, value: string) {
			writes++
			await memory.put(key, value)
		},
	}
	const owner = NormalizedOwner.nodeAddress()
	const records = [{ owner, config: { raw: '200' } }]
	const host = await createHost({
		plugins: [NormalizedOwner],
		runtime: {
			configRecords: {
				records,
				storage: () => storage,
				overlays: [
					{
						owner,
						config: { raw: '100' },
						sources: [{ path: ['raw'], kind: 'env', name: 'APP_RAW' }],
					},
				],
			},
		},
	})
	try {
		expect(writes).toBe(1)
		expect(SuperJSON.parse((await storage.getText('config.json'))!)).toEqual({
			version: 4,
			plugins: records,
		})
		await host.startNode(owner)
		await expect(host.config.get(owner)).resolves.toMatchObject({
			config: { normalized: 100, schemaDefault: 'output only' },
		})
		await new Promise((resolve) => setTimeout(resolve, 250))
		expect(writes).toBe(1)
		await host.config.patch(owner, { editable: true })
		expect(SuperJSON.parse((await storage.getText('config.json'))!)).toEqual({
			version: 4,
			plugins: [{ owner, config: { raw: '200', editable: true } }],
		})
	} finally {
		await host.close()
	}
})

it('catches up external changes made during service preparation after subscribing', async () => {
	const { SuperJSON } = await import('superjson')
	const { defineHostService } = await import('../src/services')
	const memory = createDocumentStorage()
	const owner = LayeredOwner.nodeAddress()
	let subscribed = false
	const storage = {
		...memory,
		subscribe() {
			subscribed = true
			return () => {
				subscribed = false
			}
		},
	}
	const host = await createHost({
		plugins: [LayeredOwner],
		runtime: {
			configRecords: {
				storage: () => storage,
				records: [{ owner, config: { value: 'initial' } }],
			},
		},
		services: [
			defineHostService({
				name: 'external-change',
				capabilities: [],
				async prepare() {
					expect(subscribed).toBe(false)
					await memory.put(
						'config.json',
						SuperJSON.stringify({
							version: 4,
							plugins: [{ owner, config: { value: 'during-prepare' } }],
						}),
					)
				},
			}),
		],
	})
	try {
		expect(subscribed).toBe(true)
		await expect(host.config.get(owner)).resolves.toMatchObject({
			config: { value: 'during-prepare' },
		})
	} finally {
		await host.close()
	}
	expect(subscribed).toBe(false)
})

it('retains declarations when readonly preparation finds no saved document', async () => {
	const storage = createDocumentStorage()
	const owner = LayeredOwner.nodeAddress()
	const host = await createHost({
		plugins: [LayeredOwner],
		runtime: {
			configRecords: {
				mode: 'readonly',
				storage: () => storage,
				records: [{ owner, config: { value: 'declared' } }],
			},
		},
	})
	try {
		await expect(host.config.get(owner)).resolves.toMatchObject({
			readonly: true,
			config: { value: 'declared' },
		})
		expect(await storage.stat('config.json')).toBeUndefined()
	} finally {
		await host.close()
	}
})
