import { BasePlugin, Plugin } from '@pluxel/core'
import * as v from 'valibot'
import { expect, it } from 'vitest'
import type { Script } from '../../src/agent'
import { createScriptScope, ScriptError, scriptFailure } from '../../src/agent-runtime'
import { createHost } from '../../src/index'
import { createDocumentStorage } from '../support/document-storage'

@Plugin({ forkable: true })
class Queue extends BasePlugin {
	readonly settings = this.configs.use(v.object({ workers: v.optional(v.number(), 2) }))
	private workers = 0

	init() {
		this.workers = this.settings.workers
		this.ctx.logger.info('queue ready')
		if (this.workers === 0) throw new Error('queue requires a worker')
		this.configs.onUpdate(this.settings, ({ desired }) => {
			if (desired.workers === 0) throw new Error('queue requires a worker')
			this.workers = desired.workers
		})
	}

	capacity() {
		return this.workers
	}
}

it('edits one running fork from a script and leaves the accepted change visible to the next script', async () => {
	const east = Queue.nodeAddress('east')
	const west = Queue.nodeAddress('west')
	await using host = await createHost({
		plugins: [{ plugin: Queue, forks: { east: { autoStart: true }, west: { autoStart: true } } }],
		config: { document: false },
		policy: { document: false },
	})
	await host.start()
	const scope = createScriptScope({ ctx: host.ctx })
	const task = (async (sdk) => {
		const queue = sdk.plugin(east)
		const snapshot = await queue.config.get()
		const revision = { expectedManagedRevision: snapshot.managedRevision }
		const { instance } = await queue.instance()
		const before = instance.capacity()
		const patch = await queue.config.patch({ set: { workers: before * 2 } }, revision)
		expect(patch).toMatchObject({ application: 'applied', persistence: { status: 'confirmed' } })
		await expect(queue.config.patch({ set: { workers: 99 } }, revision)).rejects.toMatchObject({
			name: 'ScriptError',
			code: 'revision_conflict',
			details: { code: 'revision_conflict', state: 'unchanged' },
		})
		return instance.capacity()
	}) satisfies Script
	const cachedReads = scope.sdk.plugins.list
	{
		await using runScope = scope
		const capacity = await task(runScope.sdk)
		expect(capacity).toBe(4)
	}
	await expect(cachedReads()).rejects.toMatchObject({ code: 'scope_closed' })
	await using next = createScriptScope({ ctx: host.ctx })
	const { instance: changed } = await next.sdk.plugin(east).instance()
	const { instance: untouched } = await next.sdk.plugin(west).instance()
	expect([changed.capacity(), untouched.capacity()]).toEqual([4, 2])
})

it('lets a script distinguish saved-but-unapplied config from a failed restart', async () => {
	await using host = await createHost({ plugins: [{ plugin: Queue, autoStart: true }] })
	await host.start()
	await using run = createScriptScope({ ctx: host.ctx })
	const queue = run.sdk.plugin(Queue.nodeAddress())
	const { instance } = await queue.instance()
	expect(await queue.config.patch({ set: { workers: 0 } })).toMatchObject({
		persistence: { status: 'confirmed' },
		application: 'saved-not-applied',
		applyFailure: { code: 'listener_failed' },
	})
	expect(instance.capacity()).toBe(2)
	const failure = await queue.restart().catch((error: unknown) => error)
	expect(failure).toBeInstanceOf(ScriptError)
	expect(scriptFailure(failure)).toMatchObject({
		code: 'lifecycle_failed',
		details: {
			report: {
				core: {
					summary: {
						lifecycleReport: { issues: [{ error: { message: 'queue requires a worker' } }] },
					},
				},
			},
		},
	})
	expect(await queue.status()).toMatchObject({ lifecycleState: 'stopped' })
})

it('preserves unknown persistence in a portable script failure and reads the last confirmed input', async () => {
	const storage = createDocumentStorage()
	await using host = await createHost({
		plugins: [{ plugin: Queue, autoStart: true }],
		config: { document: { storage: () => storage } },
	})
	await host.start()
	await using run = createScriptScope({ ctx: host.ctx })
	const queue = run.sdk.plugin(Queue.nodeAddress())
	await queue.config.patch({ set: { workers: 3 } })
	storage.put = async () => {
		throw new Error('config write unconfirmed')
	}
	const failure = await queue.config.patch({ set: { workers: 4 } }).catch((error: unknown) => error)
	expect(failure).toBeInstanceOf(ScriptError)
	expect(scriptFailure(failure)).toMatchObject({
		code: 'persistence_failed',
		details: { code: 'persistence_failed', state: 'unknown', persistence: { status: 'unknown' } },
	})
	expect(await queue.config.get()).toMatchObject({ managedInput: { workers: 3 } })
})

it('follows a queue start from a cursor, then reports a retention gap and releases cancelled waiters', async () => {
	await using host = await createHost({
		plugins: [{ plugin: Queue }],
		coreConfig: {
			logtape: ({ createRuntimeLogSink }) => ({
				sinks: { history: createRuntimeLogSink({ windowLines: 2 }) },
				loggers: [
					{ category: ['pluxel'], lowestLevel: 'trace', sinks: ['history'] },
					{ category: ['logtape', 'meta'], lowestLevel: 'fatal', sinks: [] },
				],
			}),
		},
	})
	await host.start()
	await using run = createScriptScope({ ctx: host.ctx })
	const logs = run.sdk.logs
	const cursor = await logs.mark()
	const queue = run.sdk.plugin(Queue.nodeAddress())
	const following = logs.wait(cursor, { timeoutMs: 1000, filter: { plugin: queue.address } })
	await queue.start()
	host.ctx.logging!.flushStores()
	expect(await following).toMatchObject({ lines: [{ msg: 'queue ready' }] })
	for (const index of [1, 2, 3]) host.ctx.logger.info('extra {index}', { index })
	await expect(logs.read(cursor)).rejects.toMatchObject({ code: 'from_too_old' })
	const latest = await logs.mark()
	expect(await logs.wait(latest, { timeoutMs: 5 })).toMatchObject({ lines: [] })
	const next = logs.wait(latest, { timeoutMs: 1000 })
	await Promise.resolve()
	const store = host.ctx.logging!.stores.get('default')!
	expect(store.subscriberCount).toBe(1)
	run.abort(new Error('cancel log wait'))
	await expect(next).rejects.toMatchObject({ code: 'cancelled' })
	expect(store.subscriberCount).toBe(0)
})

it('distinguishes an absent logging backend from logging without history', async () => {
	await using unconfigured = await createHost({ plugins: [] })
	await using first = createScriptScope({ ctx: unconfigured.ctx })
	await expect(first.sdk.logs.streams()).rejects.toMatchObject({ code: 'logging_unavailable' })

	await using configured = await createHost({
		plugins: [],
		coreConfig: {
			logtape: { sinks: {}, loggers: [{ category: [], lowestLevel: 'fatal', sinks: [] }] },
		},
	})
	await using second = createScriptScope({ ctx: configured.ctx })
	expect(await second.sdk.logs.streams()).toMatchObject({ streams: [] })
	await expect(second.sdk.logs.mark()).rejects.toMatchObject({ code: 'store_unavailable' })
})
