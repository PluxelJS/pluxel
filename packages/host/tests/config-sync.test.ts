import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { BasePlugin, Plugin, pluginNodeAddressOf, type PluginNodeAddress } from '@pluxel/core'
import { requireConfigService, requirePluginService } from '@pluxel/core/internal'
import { SuperJSON } from 'superjson'
import * as v from 'valibot'
import { expect, it, afterEach, beforeEach } from 'vitest'
import {
	createHost,
	defineHostService,
	resolveHostApplication,
	type HostConfigSyncOptions,
	type PluginHost,
} from '../src/index'
import { acceptReplicatedConfig } from '../src/config'
import type { HostConfigStore } from '../src/config-store'
import {
	createConfigSyncSnapshot,
	decodeConfigSyncSnapshot,
	type HostConfigSyncSnapshot,
} from '../src/config-sync-protocol'
import { createDocumentStorage } from './helpers/document-storage'
import { requirePluginHostCoordinator } from '../src/internal'

const artifact = { name: '@fixture/config-sync', catalogHash: 'a'.repeat(64) }
const credential = { identity: 'replica', token: 'test-replica-secret' }
const writerOptions = {
	role: 'writer',
	scope: 'production',
	artifact,
	identity: 'writer',
	replicas: [credential],
} as const satisfies HostConfigSyncOptions
const replicaOptions = (url = 'http://127.0.0.1:1/config'): HostConfigSyncOptions => ({
	role: 'replica',
	scope: 'production',
	artifact,
	...credential,
	writer: 'writer',
	url,
})
let validations = 0
let starts: string[] = []
let updates: string[] = []
let refuseListener = false
const schema = v.object({
	value: v.optional(
		v.pipe(
			v.string(),
			v.transform((value) => {
				validations++
				return value.toUpperCase()
			}),
		),
		'seed',
	),
	enabled: v.optional(v.boolean(), true),
})
@Plugin({ forkable: true })
class Configured extends BasePlugin {
	readonly config = this.configs.use(schema)
	init() {
		starts.push(this.config.value)
		this.configs.onUpdate(this.config, ({ desired }) => {
			updates.push(desired.value)
			if (refuseListener) throw new Error('listener refused')
		})
	}
}
@Plugin()
class Other extends BasePlugin {
	readonly config = this.configs.use(schema)
}
let rawValidations = 0
const rawSchema = v.pipe(
	v.object({ at: v.date(), ignored: v.optional(v.string()) }),
	v.transform(({ at }) => {
		rawValidations++
		return { value: at.toISOString() }
	}),
)
@Plugin()
class RawConfigured extends BasePlugin {
	readonly config = this.configs.use(rawSchema)
}
@Plugin()
class InvalidRawConfigured extends BasePlugin {
	readonly config = this.configs.use(rawSchema)
}
let owner: PluginNodeAddress
let other: PluginNodeAddress
const missing: PluginNodeAddress = {
	definition: {
		entry: { kind: 'package-root', packageName: '@fixture/missing' },
		exportName: 'Missing',
	},
	variant: 'default',
}

afterEach(() => {
	validations = 0
	starts = []
	updates = []
	refuseListener = false
	rawValidations = 0
})
beforeEach(() => {
	owner = pluginNodeAddressOf(Configured)
	other = pluginNodeAddressOf(Other)
})

function store(host: PluginHost): HostConfigStore {
	return requireConfigService(host.ctx) as HostConfigStore
}
function snapshot(host: PluginHost): HostConfigSyncSnapshot {
	const current = store(host).snapshot
	if (!current) throw new Error('Expected a saved config snapshot')
	return current
}
async function adopt(
	host: PluginHost,
	candidate: HostConfigSyncSnapshot,
	signal = new AbortController().signal,
) {
	const { records } = decodeConfigSyncSnapshot(candidate, replicaOptions())
	return acceptReplicatedConfig(host.ctx, candidate, records, {
		catalog: () => host.catalog(),
		signal,
	})
}
async function cachedReplica(
	candidate: HostConfigSyncSnapshot,
	options: Partial<Parameters<typeof createHost>[0]> = {},
) {
	const storage = createDocumentStorage()
	await storage.put('config.json', SuperJSON.stringify(candidate))
	const host = await createHost({
		plugins: [Configured, Other],
		configRecords: { storage: () => storage },
		configSync: replicaOptions(),
		...options,
	})
	await host.start()
	return { host, storage }
}
async function listen(
	handler: (request: Request) => Promise<Response>,
): Promise<{ url: string; close(): Promise<void>; server: Server }> {
	const server = createServer(async (request, response) => {
		const abort = new AbortController()
		response.once('close', () => abort.abort())
		try {
			const headers = new Headers()
			for (const [key, value] of Object.entries(request.headers))
				if (value) headers.set(key, Array.isArray(value) ? value.join(',') : value)
			const result = await handler(
				new Request(`http://${request.headers.host}${request.url}`, {
					headers,
					signal: abort.signal,
				}),
			)
			response.writeHead(result.status, Object.fromEntries(result.headers))
			response.end(await result.text())
		} catch {
			if (!response.destroyed) {
				response.writeHead(503)
				response.end()
			}
		}
	})
	server.listen(0, '127.0.0.1')
	await once(server, 'listening')
	const address = server.address()
	if (!address || typeof address === 'string') throw new Error('Expected an HTTP address')
	return {
		server,
		url: `http://127.0.0.1:${address.port}/config`,
		close: async () => {
			server.closeAllConnections()
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			)
		},
	}
}

it('commits one durable history/body and rejects globally stale or missing expected versions', async () => {
	const storage = createDocumentStorage()
	const host = await createHost({
		plugins: [Configured, Other],
		configSync: writerOptions,
		configRecords: { storage: () => storage },
	})
	try {
		const initial = host.config.status().version!
		expect(initial.seq).toBe(0)
		await expect(host.config.patch(owner, { value: 'first' })).resolves.toMatchObject({
			ok: false,
			code: 'version_conflict',
			version: initial,
		})
		await expect(
			host.config.patch(owner, { value: 'first' }, { expected: initial }),
		).resolves.toMatchObject({
			ok: true,
			saved: true,
			version: { history: initial.history, seq: 1 },
			config: { value: 'FIRST', enabled: true },
		})
		await expect(
			host.config.patch(other, { value: 'stale' }, { expected: initial }),
		).resolves.toMatchObject({ ok: false, code: 'version_conflict', version: { seq: 1 } })
		const saved = snapshot(host)
		expect(SuperJSON.parse(saved.body)).toEqual({
			version: 3,
			plugins: [{ owner, config: { value: 'first' } }],
		})
		expect(SuperJSON.parse((await storage.getText('config.json')) as string)).toEqual(saved)
		await expect(
			host.config.patch(owner, { value: 'first' }, { expected: host.config.status().version! }),
		).resolves.toMatchObject({ ok: true, saved: false, version: { seq: 1 } })
		await expect(
			host.config.reset(owner, undefined, { expected: host.config.status().version! }),
		).resolves.toMatchObject({
			ok: true,
			version: { seq: 2 },
			config: { value: 'SEED', enabled: true },
		})
		expect(SuperJSON.parse(snapshot(host).body)).toEqual({ version: 3, plugins: [] })
	} finally {
		await host.close()
	}
	const reopened = await createHost({
		plugins: [Configured],
		configSync: writerOptions,
		configRecords: { storage: () => storage },
	})
	try {
		expect(reopened.config.status().version).toMatchObject({ seq: 2 })
	} finally {
		await reopened.close()
	}
})

it('keeps an uncertain save unpublished and never retries it during another mutation or close', async () => {
	const backing = createDocumentStorage()
	let fail = false
	let writes = 0
	const storage = {
		...backing,
		async put(key: string, text: string) {
			writes++
			await backing.put(key, text)
			if (fail) throw new Error('unknown atomic commit')
		},
	}
	const host = await createHost({
		plugins: [Configured],
		configSync: writerOptions,
		configRecords: { storage: () => storage },
	})
	await host.startNode(owner)
	const initial = host.config.status().version!
	fail = true
	await expect(
		host.config.patch(owner, { value: 'unconfirmed' }, { expected: initial }),
	).resolves.toMatchObject({
		ok: false,
		code: 'persistence_failed',
		state: 'unknown',
		version: initial,
		config: { value: 'SEED' },
	})
	expect(host.config.status().version).toEqual(initial)
	expect(updates).toEqual([])
	await expect(host.config.patch(owner, { value: 'retry' }, { expected: initial })).rejects.toThrow(
		'unknown atomic commit',
	)
	await expect(host.close()).rejects.toThrow('shutdown failed')
	expect(writes).toBe(2)
	expect(
		(SuperJSON.parse((await backing.getText('config.json')) as string) as HostConfigSyncSnapshot)
			.seq,
	).toBe(1)
})

it('validates the complete effective candidate once, keeps overlays and unknown owners, and replaces deletions', async () => {
	const first = createConfigSyncSnapshot(
		writerOptions,
		[
			{ owner, config: { value: 'saved', enabled: false } },
			{ owner: other, config: { value: 'other' } },
		],
		{ history: 'history', seq: 1 },
	)
	const storage = createDocumentStorage()
	await storage.put('config.json', SuperJSON.stringify(first))
	const host = await createHost({
		plugins: [Configured, Other],
		configSync: replicaOptions(),
		configRecords: {
			storage: () => storage,
			initial: [{ owner, config: { value: 'local', enabled: true } }],
			overlays: [
				{
					owner,
					config: { value: 'environment' },
					sources: [{ path: ['value'], kind: 'env', name: 'VALUE' }],
				},
			],
		},
	})
	try {
		await host.startNode(owner)
		validations = 0
		const fork: PluginNodeAddress = {
			definition: owner.definition,
			variant: 'fork',
			forkId: 'not-created',
		}
		const changed = createConfigSyncSnapshot(
			writerOptions,
			[
				{ owner, config: { value: 'source', enabled: true } },
				{ owner: other, config: { value: 'changed' } },
				{ owner: missing, config: { value: 'opaque' } },
				{ owner: fork, config: { value: 'later' } },
			],
			{ history: 'history', seq: 2 },
		)
		expect(await adopt(host, changed)).toEqual([missing, fork])
		expect(validations).toBe(2)
		expect(store(host).getRawConfig(owner)).toEqual({ value: 'ENVIRONMENT', enabled: true })
		expect(updates).toEqual(['ENVIRONMENT'])
		expect(requirePluginService(host.ctx).isRunning(fork)).toBe(false)
		expect(await storage.getText('config.json')).toBe(SuperJSON.stringify(changed))
		const rejected = createConfigSyncSnapshot(
			writerOptions,
			[
				{ owner, config: { enabled: false } },
				{ owner: other, config: { value: 42 } },
			],
			{ history: 'history', seq: 3 },
		)
		await expect(adopt(host, rejected)).rejects.toThrow('Plugin config schema')
		expect(snapshot(host)).toEqual(changed)
		expect(updates).toEqual(['ENVIRONMENT'])
		const cleared = createConfigSyncSnapshot(writerOptions, [], { history: 'history', seq: 4 })
		await adopt(host, cleared)
		expect(store(host).getRawConfig(owner)).toEqual({ value: 'ENVIRONMENT', enabled: true })
		expect(store(host).getRawConfig(other)).toEqual({ value: 'SEED', enabled: true })
		expect(store(host).getManagedRecords()).toEqual([])
		expect(updates).toEqual(['ENVIRONMENT'])
	} finally {
		await host.close()
	}
})

it('does not revalidate/reapply duplicates, rejects conflicting bodies/history, and ignores old versions', async () => {
	const initial = createConfigSyncSnapshot(writerOptions, [], { history: 'history', seq: 0 })
	const { host } = await cachedReplica(initial)
	try {
		await host.startNode(owner)
		refuseListener = true
		const changed = createConfigSyncSnapshot(
			writerOptions,
			[{ owner, config: { value: 'changed' } }],
			{ history: 'history', seq: 2 },
		)
		await adopt(host, changed)
		validations = 0
		await adopt(host, changed)
		await adopt(host, initial)
		expect(validations).toBe(0)
		expect(updates).toEqual(['CHANGED'])
		await expect(host.config.get(owner)).resolves.toMatchObject({
			ok: true,
			application: 'saved-not-applied',
			version: { seq: 2 },
		})
		await expect(adopt(host, { ...changed, body: initial.body })).rejects.toThrow(
			'conflicting document bodies',
		)
		await expect(adopt(host, { ...changed, history: 'restored-backup' })).rejects.toThrow(
			'explicit replica rebinding',
		)
		expect(snapshot(host)).toEqual(changed)
	} finally {
		await host.close()
	}
})

it('rejects every replica management/Core write and fork cleanup before stopping the fork', async () => {
	const initial = createConfigSyncSnapshot(writerOptions, [], { history: 'history', seq: 0 })
	const { host } = await cachedReplica(initial)
	try {
		await host.forks.ensure(owner, 'tenant')
		const fork: PluginNodeAddress = {
			definition: owner.definition,
			variant: 'fork',
			forkId: 'tenant',
		}
		await host.startNode(fork)
		await expect(
			host.config.patch(owner, { value: 'no' }, { expected: host.config.status().version! }),
		).resolves.toMatchObject({ ok: false, code: 'mutation_rejected' })
		await expect(host.config.reset(owner)).resolves.toMatchObject({
			ok: false,
			code: 'mutation_rejected',
		})
		expect(() => store(host).patchConfig(owner, { value: 'no' })).toThrow('disabled')
		expect(() => store(host).unsetConfigKeys(owner, ['value'])).toThrow('disabled')
		expect(() => store(host).deleteConfig(owner)).toThrow('disabled')
		await expect(
			host.forks.remove(owner, 'tenant', { expected: host.config.status().version! }),
		).resolves.toMatchObject({ ok: false, code: 'mutation_rejected', state: 'unchanged' })
		expect(requirePluginService(host.ctx).isRunning(fork)).toBe(true)
		expect(snapshot(host)).toEqual(initial)
	} finally {
		await host.close()
	}
})

it('requires explicit conversion of old config documents and rejects invalid cache without replacing it', async () => {
	for (const options of [writerOptions, replicaOptions()]) {
		const storage = createDocumentStorage()
		const text = SuperJSON.stringify({ version: 3, plugins: [] })
		await storage.put('config.json', text)
		await expect(
			createHost({
				plugins: [Configured],
				configSync: options,
				configRecords: { storage: () => storage },
			}),
		).rejects.toThrow('explicit conversion')
		expect(await storage.getText('config.json')).toBe(text)
	}
	const invalid = createConfigSyncSnapshot(writerOptions, [{ owner, config: { value: 42 } }], {
		history: 'history',
		seq: 1,
	})
	const storage = createDocumentStorage()
	const text = SuperJSON.stringify(invalid)
	await storage.put('config.json', text)
	await expect(
		createHost({
			plugins: [Configured],
			configSync: replicaOptions(),
			configRecords: { storage: () => storage },
		}),
	).rejects.toThrow('Plugin config schema')
	expect(await storage.getText('config.json')).toBe(text)
})

it('restores a validated cache offline but fails no-cache startup without writing an empty document', async () => {
	const initial = createConfigSyncSnapshot(
		writerOptions,
		[{ owner, config: { value: 'cached' } }],
		{ history: 'history', seq: 3 },
	)
	const { host } = await cachedReplica(initial, { state: { initial: { autoStart: [owner] } } })
	try {
		expect(starts).toEqual(['CACHED'])
		expect(host.config.status()).toEqual({
			readonly: true,
			version: { history: 'history', seq: 3 },
		})
		await expect.poll(() => host.configSync!.status().connection).toBe('disconnected')
	} finally {
		await host.close()
	}
	const storage = createDocumentStorage()
	let cleaned = false
	await expect(
		createHost({
			plugins: [Configured],
			configSync: replicaOptions(),
			configRecords: { storage: () => storage },
			services: [
				defineHostService({
					name: 'prepare-observer',
					capabilities: [],
					prepare(ctx) {
						ctx.effects.defer(() => {
							cleaned = true
						})
					},
				}),
			],
		}),
	).rejects.toThrow('fetch failed')
	expect(cleaned).toBe(true)
	expect(storage.documents.size).toBe(0)
})

it('fetches before first Plugin admission, follows authenticated long polls, and catches a commit at subscription', async () => {
	const writer = await createHost({ plugins: [Configured], configSync: writerOptions })
	let replica: PluginHost | undefined
	const server = await listen((request) => writer.configSync!.fetch(request))
	try {
		await writer.config.patch(
			owner,
			{ value: 'ready' },
			{ expected: writer.config.status().version! },
		)
		replica = await createHost({
			plugins: [Configured],
			configSync: replicaOptions(server.url),
			state: { initial: { autoStart: [owner] } },
		})
		expect(starts).toEqual([])
		await replica.start()
		expect(starts).toEqual(['READY'])
		const bad = await fetch(server.url, {
			headers: { authorization: 'Bearer invalid', 'x-pluxel-config-replica': credential.identity },
		})
		expect(bad.status).toBe(401)
		await bad.body?.cancel()
		const original = store(writer).subscribeSaved.bind(store(writer))
		let committed: Promise<unknown> | undefined
		store(writer).subscribeSaved = (listener) => {
			const unsubscribe = original(listener)
			if (!committed)
				committed = writer.config.patch(
					owner,
					{ value: 'window' },
					{ expected: writer.config.status().version! },
				)
			return unsubscribe
		}
		// A current read already in flight may need one commit to reach the instrumented subscription.
		await writer.config.patch(
			owner,
			{ value: 'trigger' },
			{ expected: writer.config.status().version! },
		)
		await expect.poll(() => replica!.configSync!.status().savedVersion?.seq).toBe(3)
		expect(store(replica).getRawConfig(owner)).toMatchObject({ value: 'WINDOW' })
		await committed
	} finally {
		await replica?.close()
		await writer.close()
		await server.close()
	}
})

it('keeps a slow replica bounded, skips intermediate snapshots, and drains accepted persistence on close', async () => {
	const writer = await createHost({ plugins: [Configured], configSync: writerOptions })
	const backing = createDocumentStorage()
	const saving = Promise.withResolvers<void>()
	const release = Promise.withResolvers<void>()
	let blocked = false
	let saves = 0
	const storage = {
		...backing,
		async put(key: string, text: string) {
			saves++
			if (blocked) {
				saving.resolve()
				await release.promise
			}
			await backing.put(key, text)
		},
	}
	const server = await listen((request) => writer.configSync!.fetch(request))
	const replica = await createHost({
		plugins: [Configured],
		configSync: replicaOptions(server.url),
		configRecords: { storage: () => storage },
	})
	try {
		await replica.startNode(owner)
		blocked = true
		await writer.config.patch(
			owner,
			{ value: 'one' },
			{ expected: writer.config.status().version! },
		)
		await saving.promise
		for (let index = 2; index <= 12; index++)
			await writer.config.patch(
				owner,
				{ value: String(index) },
				{ expected: writer.config.status().version! },
			)
		expect(saves).toBe(2)
		expect(replica.configSync!.status()).toMatchObject({
			sourceVersion: { seq: 1 },
			savedVersion: { seq: 0 },
		})
		blocked = false
		release.resolve()
		await expect.poll(() => replica.configSync!.status().savedVersion?.seq).toBe(12)
		expect(saves).toBe(3)
		expect(updates).toEqual(['ONE', '12'])
	} finally {
		release.resolve()
		await replica.close()
		await writer.close()
		await server.close()
	}
})

it('retains opaque unknown raw types and validates exactly once when their real declarations are admitted', async () => {
	const rawOwner = pluginNodeAddressOf(RawConfigured)
	const invalidOwner = pluginNodeAddressOf(InvalidRawConfigured)
	const raw = { at: new Date('2026-11-01T00:00:00.000Z'), ignored: undefined as string | undefined }
	const candidate = createConfigSyncSnapshot(
		writerOptions,
		[
			{ owner: rawOwner, config: raw },
			{ owner: invalidOwner, config: { at: 'invalid' } },
			{ owner, config: { value: 'unaffected' } },
		],
		{ history: 'opaque', seq: 1 },
	)
	const { host, storage } = await cachedReplica(candidate)
	try {
		expect(host.configSync!.status().unavailable).toEqual([rawOwner, invalidOwner])
		expect(host.catalog().entries).toHaveLength(2)
		expect(requirePluginService(host.ctx).isRunning(rawOwner)).toBe(false)
		expect(rawValidations).toBe(0)
		const saved = await storage.getText('config.json')
		await host.updateCatalog([Configured, Other, RawConfigured, InvalidRawConfigured])
		await host.startNode(rawOwner)
		expect(requirePluginService(host.ctx).isRunning(rawOwner)).toBe(true)
		expect(store(host).getRawConfig(rawOwner)).toEqual({ value: raw.at.toISOString() })
		expect(rawValidations).toBe(1)
		await host.startNode(invalidOwner)
		expect(requirePluginService(host.ctx).isRunning(invalidOwner)).toBe(false)
		expect(store(host).getRawConfig(owner)).toMatchObject({ value: 'UNAFFECTED' })
		expect(await storage.getText('config.json')).toBe(saved)
		expect(snapshot(host).body).toBe(candidate.body)
		expect(store(host).getManagedConfig(invalidOwner)).toEqual({ at: 'invalid' })
	} finally {
		await host.close()
	}
})

it('preserves known schema raw Date/undefined input in the exact saved body while publishing normalized output', async () => {
	const rawOwner = pluginNodeAddressOf(RawConfigured)
	const initial = createConfigSyncSnapshot(
		writerOptions,
		[{ owner: rawOwner, config: { at: new Date('2025-11-01T00:00:00.000Z') } }],
		{ history: 'known-raw', seq: 0 },
	)
	const { host, storage } = await cachedReplica(initial, { plugins: [RawConfigured] })
	try {
		rawValidations = 0
		const candidate = createConfigSyncSnapshot(
			writerOptions,
			[
				{
					owner: rawOwner,
					config: { at: new Date('2026-11-01T00:00:00.000Z'), ignored: undefined },
				},
			],
			{ history: 'known-raw', seq: 1 },
		)
		await adopt(host, candidate)
		expect(rawValidations).toBe(1)
		await host.startNode(rawOwner)
		expect(rawValidations).toBe(1)
		expect(store(host).getRawConfig(rawOwner)).toEqual({ value: '2026-11-01T00:00:00.000Z' })
		expect(await storage.getText('config.json')).toBe(SuperJSON.stringify(candidate))
	} finally {
		await host.close()
	}
})

it('drains an accepted replica save on Host close and cancels candidates still queued for admission', async () => {
	const initial = createConfigSyncSnapshot(writerOptions, [], { history: 'drain', seq: 0 })
	const backing = createDocumentStorage()
	await backing.put('config.json', SuperJSON.stringify(initial))
	const saving = Promise.withResolvers<void>()
	const release = Promise.withResolvers<void>()
	const storage = {
		...backing,
		async put(key: string, text: string) {
			saving.resolve()
			await release.promise
			await backing.put(key, text)
		},
	}
	const host = await createHost({
		plugins: [Configured],
		configSync: replicaOptions(),
		configRecords: { storage: () => storage },
	})
	await host.start()
	const coordinator = requirePluginHostCoordinator(host.ctx)
	const entered = Promise.withResolvers<void>()
	const dequeue = Promise.withResolvers<void>()
	const blocking = coordinator.runExclusive('hold', async () => {
		entered.resolve()
		await dequeue.promise
	})
	await entered.promise
	const abort = new AbortController()
	const canceled = adopt(
		host,
		createConfigSyncSnapshot(writerOptions, [{ owner, config: { value: 'canceled' } }], {
			history: 'drain',
			seq: 1,
		}),
		abort.signal,
	)
	abort.abort(new Error('queued candidate canceled'))
	dequeue.resolve()
	await blocking
	await expect(canceled).rejects.toThrow('queued candidate canceled')
	expect(snapshot(host)).toEqual(initial)
	const next = createConfigSyncSnapshot(writerOptions, [{ owner, config: { value: 'accepted' } }], {
		history: 'drain',
		seq: 2,
	})
	const accepted = adopt(host, next)
	await saving.promise
	let closed = false
	const close = host.close().then((): undefined => {
		closed = true
		return undefined
	})
	await Promise.resolve()
	expect(closed).toBe(false)
	expect(host.configSync!.status().savedVersion).toEqual({ history: 'drain', seq: 0 })
	release.resolve()
	await accepted
	await close
	expect(await backing.getText('config.json')).toBe(SuperJSON.stringify(next))
	expect(host.configSync!.status().savedVersion).toEqual({ history: 'drain', seq: 2 })
})

it.each([
	{ scope: 'another-scope' },
	{ writer: 'untrusted-writer' },
	{ artifact: { ...artifact, catalogHash: 'c'.repeat(64) } },
	{ protocol: 'future-protocol' },
	{ seq: -1 },
])('rejects mismatched snapshot facts before candidate admission: %o', (overrides) => {
	const initial = createConfigSyncSnapshot(writerOptions, [], { history: 'source', seq: 0 })
	expect(() => decodeConfigSyncSnapshot({ ...initial, ...overrides }, replicaOptions())).toThrow(
		'[host:config-sync]',
	)
})

it('keeps a replica persistence fault observable and never reconnects to retry an uncertain write', async () => {
	const writer = await createHost({ plugins: [Configured], configSync: writerOptions })
	const backing = createDocumentStorage()
	let fail = false
	let saves = 0
	const storage = {
		...backing,
		async put(key: string, text: string) {
			saves++
			await backing.put(key, text)
			if (fail) throw new Error('replica commit outcome unknown')
		},
	}
	let requests = 0
	const server = await listen((request) => {
		requests++
		return writer.configSync!.fetch(request)
	})
	const replica = await createHost({
		plugins: [Configured],
		configSync: replicaOptions(server.url),
		configRecords: { storage: () => storage },
	})
	try {
		await replica.startNode(owner)
		fail = true
		await writer.config.patch(
			owner,
			{ value: 'unconfirmed' },
			{ expected: writer.config.status().version! },
		)
		await expect.poll(() => replica.configSync!.status().connection).toBe('failed')
		expect(replica.configSync!.status()).toMatchObject({
			sourceVersion: { seq: 1 },
			savedVersion: { seq: 0 },
			error: 'replica commit outcome unknown',
		})
		expect(store(replica).getRawConfig(owner)).toMatchObject({ value: 'SEED' })
		const failedRequests = requests
		await writer.config.patch(
			owner,
			{ value: 'later' },
			{ expected: writer.config.status().version! },
		)
		expect(requests).toBe(failedRequests)
		expect(saves).toBe(2)
		expect(updates).toEqual([])
	} finally {
		await expect(replica.close()).rejects.toThrow('shutdown failed')
		await writer.close()
		await server.close()
	}
})

it('keeps unavailable owners when discarding an old response and clears a transport error after reconnecting to the saved version', async () => {
	const current = createConfigSyncSnapshot(
		writerOptions,
		[{ owner: missing, config: { value: 'deferred' } }],
		{ history: 'diagnostics', seq: 2 },
	)
	const older = createConfigSyncSnapshot(writerOptions, [], { history: 'diagnostics', seq: 1 })
	const storage = createDocumentStorage()
	await storage.put('config.json', SuperJSON.stringify(current))
	let requests = 0
	const server = await listen(async (request) => {
		requests++
		if (requests === 1) return new Response(SuperJSON.stringify(older))
		if (requests === 2) return new Response('temporary outage', { status: 503 })
		if (requests === 3) return new Response(SuperJSON.stringify(current))
		return new Promise<Response>((_, reject) => {
			const abort = (): void => reject(request.signal.reason)
			request.signal.addEventListener('abort', abort, { once: true })
			if (request.signal.aborted) abort()
		})
	})
	const host = await createHost({
		plugins: [],
		configRecords: { storage: () => storage },
		configSync: replicaOptions(server.url),
	})
	try {
		await expect.poll(() => host.configSync!.status().error).toContain('HTTP 503')
		expect(host.configSync!.status().unavailable).toEqual([missing])
		expect(host.config.status().version).toEqual({ history: 'diagnostics', seq: 2 })
		await expect.poll(() => host.configSync!.status().error).toBeNull()
		expect(host.configSync!.status().unavailable).toEqual([missing])
		expect(host.configSync!.status().sourceVersion).toEqual({ history: 'diagnostics', seq: 2 })
	} finally {
		await host.close()
		await server.close()
	}
})

it('checks sync artifact against trusted deployment facts and rejects null options', async () => {
	const startup = {
		root: '/application',
		mode: 'production' as const,
		env: {},
		bindings: {},
		deployment: {
			root: '/application',
			target: 'node' as const,
			variant: 'headless' as const,
			application: artifact,
		},
	}
	const resolved = await resolveHostApplication(
		() => ({ plugins: [], configSync: writerOptions }),
		startup,
	)
	expect(resolved.configSync?.artifact).toEqual(artifact)
	await expect(
		resolveHostApplication(() => ({ plugins: [], configSync: writerOptions }), {
			...startup,
			deployment: {
				...startup.deployment,
				application: { ...artifact, catalogHash: 'd'.repeat(64) },
			},
		}),
	).rejects.toThrow('deployed application artifact')
	await expect(
		resolveHostApplication(() => ({ plugins: [], configSync: writerOptions }), {
			...startup,
			deployment: { root: '/application', target: 'node', variant: 'headless' },
		}),
	).rejects.toThrow('deployed application artifact')
	await expect(createHost({ plugins: [], configSync: null as never })).rejects.toThrow(
		'must be an object',
	)
})
