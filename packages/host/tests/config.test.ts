import { createDocumentStorage } from './helpers/document-storage'
import { BasePlugin, Plugin } from '@pluxel/core'
import { SuperJSON } from 'superjson'
import * as v from 'valibot'
import { expect, it } from 'vitest'
import { createHost } from '../src/index'
import { requireConfigService } from '@pluxel/core/internal'

const updates: string[] = []
const Config = v.object({
	value: v.optional(v.string(), 'initial'),
	nested: v.optional(v.object({ count: v.optional(v.number(), 0) }), {}),
	extra: v.optional(v.string()),
})
@Plugin({ forkable: true })
class ConfigOwner extends BasePlugin {
	readonly config = this.configs.use(Config)
	init() {
		this.configs.onUpdate(this.config, ({ desired }) => {
			updates.push(desired.value)
		})
	}
}
const branchSchema = v.variant('kind', [
	v.strictObject({ kind: v.literal('socket'), socket: v.string() }),
	v.strictObject({ kind: v.literal('http'), url: v.string() }),
])
@Plugin()
class Branch extends BasePlugin {
	readonly config = this.configs.use(
		v.object({ transport: v.optional(branchSchema, { kind: 'socket', socket: '/tmp/example' }) }),
	)
}
let transformations = 0
const transformedSchema = v.object({
	value: v.pipe(
		v.optional(v.string(), 'default'),
		v.transform((value) => {
			transformations++
			return `${value}!`
		}),
	),
})
@Plugin()
class Transformed extends BasePlugin {
	readonly config = this.configs.use(transformedSchema)
}
it('validates raw edits, confirms running notifications, resets inheritance and closes admission', async () => {
	const owner = ConfigOwner.nodeAddress()
	const host = await createHost({
		plugins: [ConfigOwner],
		runtime: { documents: { config: false, state: false } },
	})
	try {
		await expect(host.config.validate(owner, { set: { value: 42 } })).resolves.toMatchObject({
			ok: false,
			code: 'validation_failed',
		})
		const before = await host.config.get(owner)
		expect(before).toMatchObject({
			ok: true,
			managedInput: null,
			effectiveInput: {},
			config: { value: 'initial' },
			persistence: { status: 'unchanged' },
		})
		await expect(host.config.patch(owner, { set: { value: 'saved' } })).resolves.toMatchObject({
			ok: true,
			application: 'deferred',
			persistence: { status: 'confirmed', retention: 'session' },
		})
		await host.startNode(owner)
		updates.length = 0
		await expect(host.config.patch(owner, { set: { value: 'updated' } })).resolves.toMatchObject({
			ok: true,
			application: 'applied',
		})
		await expect(host.config.reset(owner)).resolves.toMatchObject({
			ok: true,
			managedInput: null,
			config: { value: 'initial' },
			application: 'applied',
		})
		expect(updates).toEqual(['updated', 'initial'])
		await host.updateCatalog([])
		await expect(host.config.patch(owner, { set: { value: 'orphan' } })).resolves.toMatchObject({
			ok: false,
			code: 'node_unavailable',
		})
	} finally {
		await host.close()
	}
	await expect(host.config.get(owner)).rejects.toThrow('closed')
})
it('separates per-node modes, declared fallback and missing document input', async () => {
	const owner = ConfigOwner.nodeAddress()
	const storage = createDocumentStorage()
	const east = ConfigOwner.nodeAddress('east')
	const west = ConfigOwner.nodeAddress('west')
	await storage.put(
		'config.json',
		SuperJSON.stringify({
			version: 4,
			plugins: [owner, east, west].map((node) => ({
				owner: node,
				config: { value: 'saved', extra: 'retained' },
			})),
		}),
	)
	const host = await createHost({
		plugins: [ConfigOwner],
		policy: { forks: [east, west] },
		config: {
			mode: 'declared-only',
			records: [
				{ owner: ConfigOwner, config: { value: 'declared' } },
				{ owner: east, mode: 'saved-first', config: { value: 'east' } },
				{ owner: west, mode: 'declared-first', config: { value: 'west' } },
			],
		},
		runtime: { documents: { config: { storage: () => storage }, state: false } },
	})
	try {
		expect(await host.config.get(owner)).toMatchObject({
			mode: 'declared-only',
			config: { value: 'declared' },
			shadowedPaths: [['value'], ['extra']],
		})
		expect(await host.config.get(east)).toMatchObject({
			mode: 'saved-first',
			config: { value: 'saved', extra: 'retained' },
		})
		expect(await host.config.get(west)).toMatchObject({
			mode: 'declared-first',
			config: { value: 'west', extra: 'retained' },
		})
	} finally {
		await host.close()
	}
})
it('does not seed documents and saves hidden raw values without changing desired revision', async () => {
	const owner = ConfigOwner.nodeAddress()
	const storage = createDocumentStorage()
	let writes = 0
	const borrowed = {
		...storage,
		async put(key: string, value: string) {
			writes++
			await storage.put(key, value)
		},
	}
	const host = await createHost({
		plugins: [ConfigOwner],
		config: { records: [{ owner, config: { value: 'declaration' } }] },
		runtime: { documents: { config: { storage: () => borrowed }, state: false } },
	})
	try {
		const first = await host.config.get(owner)
		if (first.ok === false) throw new Error(first.message)
		expect(writes).toBe(0)
		expect(first.managedInput).toBeNull()
		const hidden = await host.config.patch(
			owner,
			{ set: { value: 200 } },
			{ expectedManagedRevision: first.managedRevision },
		)
		expect(hidden).toMatchObject({
			ok: true,
			managedInput: { value: 200 },
			config: { value: 'declaration' },
			shadowedPaths: [['value']],
			desiredRevision: first.desiredRevision,
			persistence: { status: 'confirmed', retention: 'unknown' },
		})
		if (hidden.ok === false) throw new Error(hidden.message)
		expect(hidden.managedRevision).not.toBe(first.managedRevision)
		await expect(
			host.config.patch(
				owner,
				{ set: { extra: 'stale' } },
				{ expectedManagedRevision: first.managedRevision },
			),
		).resolves.toMatchObject({
			ok: false,
			code: 'revision_conflict',
			managedRevision: hidden.managedRevision,
		})
		expect(writes).toBe(1)
		expect(SuperJSON.parse((await storage.getText('config.json'))!)).toEqual({
			version: 4,
			plugins: [{ owner, config: { value: 200 } }],
		})
		expect(() => requireConfigService(host.ctx).patchConfig(owner, { value: 'bypass' })).toThrow(
			'host.config',
		)
	} finally {
		await host.close()
	}
	const reopened = await createHost({
		plugins: [ConfigOwner],
		config: { mode: 'saved-first', records: [{ owner, config: { value: 'fallback' } }] },
		runtime: { documents: { config: { storage: () => storage }, state: false } },
	})
	try {
		await expect(reopened.config.get(owner)).resolves.toMatchObject({
			ok: false,
			code: 'validation_failed',
			managedInput: { value: 200 },
			effectiveInput: { value: 200 },
			mode: 'saved-first',
		})
	} finally {
		await reopened.close()
	}
})
it('performs branch replacement atomically and prunes removed paths', async () => {
	const node = Branch.nodeAddress()
	const host = await createHost({
		plugins: [Branch],
		config: { mode: 'saved-first' },
		runtime: { documents: { config: false, state: false } },
	})
	try {
		await expect(
			host.config.patch(node, { set: { transport: { kind: 'socket', socket: '/tmp/managed' } } }),
		).resolves.toMatchObject({ ok: true })
		const before = await host.config.get(node)
		await expect(
			host.config.patch(node, {
				set: { transport: { kind: 'http', url: 'https://example.test' } },
			}),
		).resolves.toMatchObject({ ok: false, code: 'validation_failed', state: 'unchanged' })
		expect(await host.config.get(node)).toEqual(before)
		await expect(
			host.config.patch(node, {
				remove: [['transport']],
				set: { transport: { kind: 'http', url: 'https://example.test' } },
			}),
		).resolves.toMatchObject({
			ok: true,
			managedInput: { transport: { kind: 'http', url: 'https://example.test' } },
		})
		await expect(host.config.reset(node, [['transport']])).resolves.toMatchObject({
			ok: true,
			managedInput: null,
			config: { transport: { kind: 'socket', socket: '/tmp/example' } },
		})
		for (const remove of [[['transport'], ['transport', 'url']], [['__proto__']], [[]]])
			await expect(host.config.patch(node, { remove })).resolves.toMatchObject({
				ok: false,
				code: 'invalid_input',
			})
	} finally {
		await host.close()
	}
})
it('retains the confirmed generation and raw revision when document completion is unknown', async () => {
	const owner = ConfigOwner.nodeAddress()
	const storage = createDocumentStorage()
	let fail = false
	const borrowed = {
		...storage,
		async put(key: string, value: string) {
			if (fail) throw new Error('write unavailable')
			await storage.put(key, value)
		},
	}
	const host = await createHost({
		plugins: [ConfigOwner],
		policy: { autoStart: [ConfigOwner] },
		runtime: { documents: { config: { storage: () => borrowed }, state: false } },
	})
	try {
		await host.config.patch(owner, { set: { value: 'confirmed' } })
		const before = await host.config.get(owner)
		if (before.ok === false) throw new Error(before.message)
		fail = true
		await expect(host.config.patch(owner, { set: { value: 'uncertain' } })).resolves.toMatchObject({
			ok: false,
			code: 'persistence_failed',
			state: 'unknown',
			persistence: { status: 'unknown' },
			managedInput: { value: 'confirmed' },
			managedRevision: before.managedRevision,
		})
		expect(await host.config.get(owner)).toMatchObject({
			config: { value: 'confirmed' },
			desiredRevision: before.desiredRevision,
			managedInput: { value: 'confirmed' },
		})
		fail = false
		await expect(host.config.patch(owner, { set: { value: 'retry' } })).resolves.toMatchObject({
			ok: true,
			application: 'applied',
			config: { value: 'retry' },
		})
	} finally {
		await host.close()
	}
})
it('reuses transformed output for reads and hidden saves', async () => {
	transformations = 0
	const node = Transformed.nodeAddress()
	const host = await createHost({
		plugins: [Transformed],
		config: { records: [{ owner: Transformed, config: { value: 'raw' } }] },
		runtime: { documents: { config: false, state: false } },
	})
	try {
		expect(await host.config.get(node)).toMatchObject({ config: { value: 'raw!' } })
		expect(transformations).toBe(1)
		const count = transformations
		await host.config.get(node)
		await host.config.validate(node, {})
		expect(await host.config.patch(node, { set: { value: 'hidden' } })).toMatchObject({
			config: { value: 'raw!' },
			managedInput: { value: 'hidden' },
		})
		expect(transformations).toBe(count)
	} finally {
		await host.close()
	}
})
it('readOnly constrains management writes independently of mode', async () => {
	const owner = ConfigOwner.nodeAddress()
	const host = await createHost({
		plugins: [ConfigOwner],
		config: { mode: 'declared-only', records: [{ owner, config: { value: 'declared' } }] },
		runtime: { documents: { config: { readOnly: true }, state: false } },
	})
	try {
		expect(await host.config.get(owner)).toMatchObject({
			readonly: true,
			managedInput: null,
			config: { value: 'declared' },
		})
		expect(await host.config.patch(owner, { set: { value: 'saved' } })).toMatchObject({
			ok: false,
			code: 'mutation_rejected',
		})
		expect(await host.config.validate(owner, { set: { value: 'candidate' } })).toMatchObject({
			ok: true,
			config: { value: 'declared' },
		})
	} finally {
		await host.close()
	}
})
it('checks competing editors inside the queue and preserves explicit empty input on a no-op reset', async () => {
	const owner = ConfigOwner.nodeAddress()
	const host = await createHost({
		plugins: [ConfigOwner],
		runtime: { documents: { config: false, state: false } },
	})
	try {
		const initial = await host.config.patch(owner, { set: {} })
		if (initial.ok === false) throw new Error(initial.message)
		expect(initial.managedInput).toEqual({})
		expect(await host.config.reset(owner, [['missing']])).toMatchObject({
			managedInput: {},
			managedRevision: initial.managedRevision,
			persistence: { status: 'unchanged' },
		})
		const results = await Promise.all([
			host.config.patch(
				owner,
				{ set: { value: 'first' } },
				{ expectedManagedRevision: initial.managedRevision },
			),
			host.config.patch(
				owner,
				{ set: { value: 'second' } },
				{ expectedManagedRevision: initial.managedRevision },
			),
		])
		expect(results.map((result) => result.ok)).toEqual([true, false])
		expect(results[1]).toMatchObject({ code: 'revision_conflict' })
		const sparse = Array(1) as string[]
		expect(await host.config.patch(owner, { remove: [sparse] })).toMatchObject({
			ok: false,
			code: 'invalid_input',
		})
	} finally {
		await host.close()
	}
})

it('reports only accepted raw facts when repairing invalid input fails to persist', async () => {
	const owner = ConfigOwner.nodeAddress()
	const storage = createDocumentStorage()
	await storage.put(
		'config.json',
		SuperJSON.stringify({ version: 4, plugins: [{ owner, config: { value: 123 } }] }),
	)
	await using host = await createHost({
		plugins: [ConfigOwner],
		runtime: {
			documents: {
				state: false,
				config: {
					storage: () => ({
						...storage,
						put: async () => {
							throw new Error('write unavailable')
						},
					}),
				},
			},
		},
	})
	const invalid = await host.config.get(owner)
	expect(invalid).toMatchObject({
		ok: false,
		code: 'validation_failed',
		managedInput: { value: 123 },
	})
	const result = await host.config.patch(owner, { set: { value: 'repaired' } })
	expect(result).toMatchObject({
		ok: false,
		code: 'persistence_failed',
		state: 'unknown',
		managedInput: { value: 123 },
		effectiveInput: { value: 123 },
		persistence: { status: 'unknown' },
	})
	expect(result).not.toHaveProperty('config')
	expect(result).not.toHaveProperty('application')
	if (invalid.ok !== false || invalid.code !== 'validation_failed')
		throw new Error('Expected invalid input')
	expect(result).toHaveProperty('managedRevision', invalid.managedRevision)
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
			ConfigOwner.nodeAddress(),
			{ set: { value: 'canceled' } },
			{ signal: queuedSignal.signal },
		)
		queuedSignal.abort()
		admittedSignal.abort()
		release.resolve()
		expect(await admitted).toBe(42)
		await expect(queued).rejects.toMatchObject({ name: 'AbortError' })
		expect(await host.config.get(ConfigOwner.nodeAddress())).toMatchObject({
			ok: true,
			managedInput: null,
			config: { value: 'initial' },
		})
	} finally {
		release.resolve()
		await host.close()
	}
})

it('catches up external changes made during service preparation after subscribing', async () => {
	const { defineHostService } = await import('../src/services')
	const memory = createDocumentStorage()
	const owner = ConfigOwner.nodeAddress()
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
		plugins: [ConfigOwner],
		config: { mode: 'saved-first', records: [{ owner, config: { value: 'initial' } }] },
		runtime: { documents: { config: { storage: () => storage }, state: false } },
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
