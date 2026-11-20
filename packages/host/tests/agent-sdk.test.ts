import { BasePlugin, Plugin, parsePluginNodeAddress } from '@pluxel/core'
import { requirePluginService } from '@pluxel/core/internal'
import { expect, it, vi } from 'vitest'
import { createHost } from '../src/index'
import type { Script } from '../src/agent'
import { createScriptScope, ScriptError, scriptFailure } from '../src/agent-runtime'
import { requirePluginHostCoordinator } from '../src/internal'
import { createDocumentStorage } from './helpers/document-storage'

const schema = {
	'~standard': {
		version: 1 as const,
		vendor: 'agent-sdk-test',
		types: undefined as { input: Record<string, unknown>; output: { count: number } } | undefined,
		validate(input: unknown) {
			const count = (input as { count?: unknown })?.count ?? 2
			return typeof count === 'number'
				? { value: { count } }
				: { issues: [{ message: 'count must be a number', path: ['count'] }] }
		},
	},
}

@Plugin({ forkable: true })
class Counter extends BasePlugin {
	readonly config = this.configs.use(schema)
	count = 2
	init() {
		this.ctx.logger.info('counter started')
		this.configs.onUpdate(this.config, ({ desired }) => {
			this.count = desired.count
		})
	}
}

it('applies a typed script mutation, then rejects a stale edit without undoing the accepted change', async () => {
	await using host = await createHost({
		plugins: [{ plugin: Counter, autoStart: true }],
		policy: { document: false },
		config: { document: false },
	})
	await host.start()
	await using scope = createScriptScope({ ctx: host.ctx })
	const node = parsePluginNodeAddress(Counter.nodeAddress())
	const script = (async (sdk) => {
		const selected = sdk.plugin(node)
		const before = await selected.config.get()
		await selected.config.patch(
			{ set: { count: 4 } },
			{
				expectedManagedRevision: before.managedRevision,
			},
		)
		await selected.config.patch(
			{ set: { count: 8 } },
			{
				expectedManagedRevision: before.managedRevision,
			},
		)
	}) satisfies Script
	await expect(script(scope.sdk)).rejects.toMatchObject({
		name: 'ScriptError',
		code: 'revision_conflict',
		details: { code: 'revision_conflict', state: 'unchanged' },
	})
	await expect(scope.sdk.plugin(node).config.get()).resolves.toMatchObject({
		config: { count: 4 },
		application: 'applied',
	})
	expect(requirePluginService(host.ctx).getInstance(node)).toMatchObject({ count: 4 })
})

it('preserves shadowed raw inputs, source facts and readonly rejection', async () => {
	const node = parsePluginNodeAddress(Counter.nodeAddress())
	await using host = await createHost({
		plugins: [
			{
				plugin: Counter,
				config: { count: 7 },
			},
		],
		config: {
			mode: 'declared-only',
			document: false,
		},
		policy: {
			document: false,
		},
	})
	await host.start()
	const scope = createScriptScope({ ctx: host.ctx })
	try {
		expect(await scope.sdk.plugin(node).config.patch({ set: { count: 100 } })).toMatchObject({
			managedInput: { count: 100 },
			effectiveInput: { count: 7 },
			config: { count: 7 },
			shadowedPaths: [['count']],
			sources: [{ kind: 'declaration', path: ['count'] }],
		})
		const initial = await scope.sdk.policy.get()
		expect(await scope.sdk.policy.validate({ startTimeoutMs: 4000 })).toMatchObject({
			persistence: { status: 'unchanged' },
		})
		expect(await scope.sdk.policy.get()).toMatchObject({ managedInput: {} })
		expect(
			await scope.sdk.policy.patch(
				{ startTimeoutMs: 4000 },
				{ expectedManagedRevision: initial.managedRevision },
			),
		).toMatchObject({
			managedInput: { startTimeoutMs: 4000 },
			pendingExecutionFields: ['startTimeoutMs'],
			appliedExecution: { startTimeoutMs: 1500 },
		})
		await expect(
			scope.sdk.policy.reset(undefined, { expectedManagedRevision: initial.managedRevision }),
		).rejects.toMatchObject({ details: { code: 'revision_conflict' } })
	} finally {
		await scope.dispose()
	}
	await using readonly = await createHost({
		plugins: [
			{
				plugin: Counter,
			},
		],
		policy: {
			document: { readOnly: true },
		},
		config: {
			document: { readOnly: true },
		},
	})
	await readonly.start()
	const locked = createScriptScope({ ctx: readonly.ctx })
	try {
		await expect(locked.sdk.plugin(node).config.patch({ set: { count: 3 } })).rejects.toMatchObject(
			{
				details: {
					code: 'mutation_rejected',
					state: 'unchanged',
				},
			},
		)
		await expect(locked.sdk.policy.patch({ startConcurrency: 2 })).rejects.toMatchObject({
			details: {
				code: 'mutation_rejected',
			},
		})
	} finally {
		await locked.dispose()
	}
})

@Plugin()
class RejectConfig extends BasePlugin {
	readonly config = this.configs.use(schema)
	init() {
		this.configs.onUpdate(this.config, () => {
			throw new Error('listener refused')
		})
	}
}

@Plugin()
class Broken extends BasePlugin {
	init() {
		throw new Error('startup refused')
	}
}

it('keeps saved-but-not-applied values and complete lifecycle failure details', async () => {
	await using host = await createHost({
		plugins: [
			{
				plugin: RejectConfig,
			},
			{
				plugin: Broken,
			},
		],
	})
	await host.start()
	const scope = createScriptScope({ ctx: host.ctx })
	try {
		await scope.sdk.plugin(parsePluginNodeAddress(RejectConfig.nodeAddress())).start()
		expect(
			await scope.sdk
				.plugin(parsePluginNodeAddress(RejectConfig.nodeAddress()))
				.config.patch({ set: { count: 5 } }),
		).toMatchObject({
			config: { count: 5 },
			application: 'saved-not-applied',
			persistence: { status: 'confirmed' },
			applyFailure: { code: 'listener_failed' },
		})
		expect(
			(
				requirePluginService(host.ctx).getInstance(
					parsePluginNodeAddress(RejectConfig.nodeAddress()),
				) as RejectConfig
			).config,
		).toMatchObject({ count: 2 })
		const started = scope.sdk.plugin(parsePluginNodeAddress(Broken.nodeAddress())).start()
		await expect(started).rejects.toMatchObject({
			details: {
				code: 'lifecycle_failed',
				report: {
					core: {
						status: 'committed',
						summary: {
							lifecycleReport: {
								ok: false,
								issues: [
									{
										plugin: parsePluginNodeAddress(Broken.nodeAddress()),
										error: { message: 'startup refused' },
									},
								],
							},
						},
					},
				},
			},
		})
		const lifecycleFailure = await started.catch((error: unknown) => error)
		if (!(lifecycleFailure instanceof ScriptError)) throw new Error('Expected a lifecycle failure')
		const encoded = scriptFailure(lifecycleFailure)
		expect(encoded).toMatchObject({ code: 'lifecycle_failed' })
		expect(encoded.details).toEqual(lifecycleFailure.details)
		expect(
			await scope.sdk.plugin(parsePluginNodeAddress(Broken.nodeAddress())).status(),
		).toMatchObject({
			lifecycleState: 'stopped',
		})
		expect(await scope.sdk.updates.latest()).toBeNull()
	} finally {
		await scope.dispose()
	}
})

it('does not publish a configuration whose persistence acknowledgement failed', async () => {
	const storage = createDocumentStorage()
	await using host = await createHost({
		plugins: [
			{
				plugin: Counter,
			},
		],
		policy: {
			document: false,
		},
		config: {
			document: { storage: () => storage },
		},
	})
	await host.start()
	const scope = createScriptScope({ ctx: host.ctx })
	try {
		const before = await scope.snapshot()
		storage.put = async () => {
			throw new Error('write acknowledgement lost')
		}
		const mutation = scope.sdk
			.plugin(parsePluginNodeAddress(Counter.nodeAddress()))
			.config.patch({ set: { count: 10 } })
		await expect(mutation).rejects.toMatchObject({
			details: {
				code: 'persistence_failed',
				state: 'unknown',
				persistence: { status: 'unknown' },
			},
		})
		const persistenceFailure = await mutation.catch((error: unknown) => error)
		expect(scriptFailure(persistenceFailure)).toMatchObject({
			code: 'persistence_failed',
			details: {
				code: 'persistence_failed',
				state: 'unknown',
				persistence: { status: 'unknown' },
			},
		})
		expect(
			await scope.sdk.plugin(parsePluginNodeAddress(Counter.nodeAddress())).config.get(),
		).toMatchObject({
			managedInput: null,
			config: { count: 2 },
		})
		const after = await scope.snapshot()
		expect(after.configManagedRevision).toBe(before.configManagedRevision)
	} finally {
		await scope.dispose()
	}
})

let startup = Promise.withResolvers<void>()
let finishStartup = Promise.withResolvers<void>()
@Plugin()
class Delayed extends BasePlugin {
	async init() {
		startup.resolve()
		await finishStartup.promise
	}
}

it('closes lexical scopes after normal return and a thrown task without closing the borrowed Host', async () => {
	await using host = await createHost({
		plugins: [
			{
				plugin: Counter,
			},
		],
	})
	await host.start()
	const normal = createScriptScope({ ctx: host.ctx })
	{
		await using scope = normal
		await scope.sdk.plugin(Counter.nodeAddress()).start()
	}
	await expect(normal.sdk.plugins.list()).rejects.toMatchObject({
		details: { code: 'scope_closed' },
	})
	const failed = createScriptScope({ ctx: host.ctx })
	const failure = new Error('task failed')
	await expect(
		(async () => {
			await using scope = failed
			await scope.sdk.plugins.list()
			throw failure
		})(),
	).rejects.toBe(failure)
	await expect(failed.sdk.plugins.list()).rejects.toMatchObject({
		details: { code: 'scope_closed' },
	})
	expect(requirePluginService(host.ctx).isRunning(Counter.nodeAddress())).toBe(true)
})

it('shares standard and explicit cleanup rejection while draining an admitted failure', async () => {
	await using host = await createHost({ plugins: [] })
	await host.start()
	const scope = createScriptScope({ ctx: host.ctx })
	const entered = Promise.withResolvers<void>()
	const release = Promise.withResolvers<void>()
	const failure = new Error('committed read failed')
	const read = vi
		.spyOn(requirePluginHostCoordinator(host.ctx), 'readCommitted')
		.mockImplementationOnce(async () => {
			entered.resolve()
			await release.promise
			throw failure
		})
	const admitted = scope.sdk.plugins.list()
	await entered.promise
	const settlement = scope[Symbol.asyncDispose]()
	expect(scope.dispose()).toBe(settlement)
	try {
		queueMicrotask(() => release.resolve())
		await Promise.all([
			expect(admitted).rejects.toBe(failure),
			expect(settlement).rejects.toMatchObject({ errors: [failure] }),
		])
		expect(scope[Symbol.asyncDispose]()).toBe(settlement)
	} finally {
		read.mockRestore()
	}
})

it('closes cached admission on cancellation and drains a real accepted Host mutation', async () => {
	startup = Promise.withResolvers<void>()
	finishStartup = Promise.withResolvers<void>()
	await using host = await createHost({
		plugins: [
			{
				plugin: Delayed,
			},
		],
	})
	await host.start()
	const controller = new AbortController()
	const scope = createScriptScope({ ctx: host.ctx, signal: controller.signal })
	const cached = scope.sdk.plugins.list
	const admitted = scope.sdk.plugin(parsePluginNodeAddress(Delayed.nodeAddress())).start()
	await startup.promise
	controller.abort(new Error('user cancelled'))
	await expect(cached()).rejects.toMatchObject({
		details: { code: 'scope_closed' },
	})
	let disposed = false
	const settlement = scope[Symbol.asyncDispose]()
	expect(scope.dispose()).toBe(settlement)
	const disposal = settlement.then((): void => {
		disposed = true
		return undefined
	})
	expect(disposed).toBe(false)
	finishStartup.resolve()
	await admitted
	await disposal
	expect(disposed).toBe(true)
	expect(
		requirePluginService(host.ctx).isRunning(parsePluginNodeAddress(Delayed.nodeAddress())),
	).toBe(true)
	expect(scope[Symbol.asyncDispose]()).toBe(scope.dispose())
	expect(await scope.snapshot()).toMatchObject({
		catalogRevision: expect.any(Number),
		configManagedRevision: expect.any(String),
		policyManagedRevision: expect.any(String),
	})
	const next = createScriptScope({ ctx: host.ctx })
	try {
		expect(
			await next.sdk.plugin(parsePluginNodeAddress(Delayed.nodeAddress())).status(),
		).toMatchObject({
			lifecycleState: 'running',
		})
	} finally {
		await next.dispose()
	}
})

it('reads real bounded logging streams, waits with a deadline and preserves retention gaps', async () => {
	await using host = await createHost({
		plugins: [
			{
				plugin: Counter,
			},
		],
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
	const scope = createScriptScope({ ctx: host.ctx })
	try {
		const streams = await scope.sdk.logs.streams()
		expect(streams.streams).toMatchObject([{ streamId: 'default', retention: { windowLines: 2 } }])
		const cursor = await scope.sdk.logs.mark()
		for (const invalid of [
			{ cursor: { ...cursor, rootId: 'other-host' }, code: 'root_mismatch' },
			{ cursor: { ...cursor, bootId: 'replaced-stream' }, code: 'stream_replaced' },
			{ cursor: { ...cursor, streamId: 'unconfigured-stream' }, code: 'store_unavailable' },
		]) {
			const rejected = await scope.sdk.logs.read(invalid.cursor).catch((error: unknown) => error)
			expect(rejected).toMatchObject({
				details: { code: invalid.code, message: expect.any(String) },
			})
			if (!(rejected instanceof ScriptError)) throw new Error('Expected the cursor to be rejected')
			expect(rejected.details.message).not.toBe('')
			expect(Object.isFrozen(rejected.details)).toBe(true)
		}
		await scope.sdk.plugin(parsePluginNodeAddress(Counter.nodeAddress())).start()
		expect(
			await scope.sdk.logs.read(cursor, {
				filter: { plugin: parsePluginNodeAddress(Counter.nodeAddress()) },
			}),
		).toMatchObject({ lines: [{ msg: 'counter started' }] })
		const end = await scope.sdk.logs.mark()
		expect(await scope.sdk.logs.wait(end, { timeoutMs: 5 })).toMatchObject({
			lines: [],
		})
		const waiting = scope.sdk.logs.wait(end, {
			timeoutMs: 1000,
			filter: { category: 'pluxel.runtime.*' },
		})
		await Promise.resolve()
		host.ctx.logger.info('new diagnostic')
		host.ctx.logging!.flushStores()
		expect(await waiting).toMatchObject({ lines: [{ msg: 'new diagnostic' }] })
		for (let i = 0; i < 5; i++) host.ctx.logger.info('retained {i}', { i })
		await expect(scope.sdk.logs.read(cursor)).rejects.toMatchObject({
			details: { code: 'from_too_old' },
		})
		await expect(scope.sdk.logs.read(end, { limit: 10001 })).rejects.toThrow('1 to 10000')
		const after = await scope.sdk.logs.mark()
		const pending = scope.sdk.logs.wait(after, { timeoutMs: 1000 })
		await Promise.resolve()
		expect(host.ctx.logging!.stores.get('default')!.subscriberCount).toBe(1)
		scope.abort(new Error('cancel log wait'))
		await expect(pending).rejects.toMatchObject({
			details: { code: 'cancelled' },
		})
		expect(host.ctx.logging!.stores.get('default')!.subscriberCount).toBe(0)
	} finally {
		await scope.dispose()
	}
})

it('reports missing history capabilities without installing a logging backend', async () => {
	await using host = await createHost({ plugins: [] })
	const scope = createScriptScope({ ctx: host.ctx })
	try {
		await expect(scope.sdk.logs.streams()).rejects.toMatchObject({
			details: { code: 'logging_unavailable' },
		})
		expect(host.ctx.logging).toBeUndefined()
	} finally {
		await scope.dispose()
	}
	await using logs = await createHost({
		plugins: [],
		coreConfig: {
			logtape: { sinks: {}, loggers: [{ category: [], lowestLevel: 'fatal', sinks: [] }] },
		},
	})
	const noHistory = createScriptScope({ ctx: logs.ctx })
	try {
		expect(await noHistory.sdk.logs.streams()).toMatchObject({ streams: [] })
		await expect(noHistory.sdk.logs.mark()).rejects.toMatchObject({
			details: { code: 'store_unavailable' },
		})
		expect(logs.ctx.logging!.stores.list()).toEqual([])
	} finally {
		await noHistory.dispose()
	}
})
