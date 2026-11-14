import { BasePlugin, Plugin } from '@pluxel/core'
import { Result, Ok, Err } from '@pluxel/core/better-result'
import { logtape } from '@pluxel/core/config'
import { requirePluginService } from '@pluxel/core/internal'
import { expect, it } from 'vitest'
import { createHost } from '../src/index'
import { createScriptScope, type Script } from '../src/agent'
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

it('runs ordinary typed configuration tasks against a Host without official Services', async () => {
	await using host = await createHost({
		plugins: [Counter],
		runtime: { documents: { config: false, state: false } },
	})
	await host.start()
	const scope = createScriptScope({ ctx: host.ctx })
	const node = Counter.nodeAddress()
	try {
		Result.unwrap(await scope.sdk.plugin(node).start())
		const script = ((sdk, run) =>
			sdk.Result.gen(async function* () {
				run.signal.throwIfAborted()
				const selected = sdk.plugin(node)
				const before = yield* sdk.Result.await(selected.config.get())
				const count = before.config.count
				if (typeof count !== 'number') throw new TypeError('Expected numeric count')
				const changed = yield* sdk.Result.await(
					selected.config.patch(
						{ set: { count: count * 2 } },
						{ expectedManagedRevision: before.managedRevision },
					),
				)
				return sdk.Result.ok({
					changed,
					actual: yield* sdk.Result.await(selected.config.get()),
					status: yield* sdk.Result.await(selected.status()),
				})
			})) satisfies Script
		const result = await script(scope.sdk, {
			id: 'config-task',
			input: null,
			signal: new AbortController().signal,
		})
		expect(result).toBeInstanceOf(Ok)
		expect(Result.unwrap(result)).toMatchObject({
			changed: {
				application: 'applied',
				persistence: { status: 'confirmed', retention: 'session' },
			},
			actual: { config: { count: 4 } },
			status: { lifecycleState: 'running' },
		})
		expect(requirePluginService(host.ctx).getInstance(node)).toMatchObject({ count: 4 })
		const saved = Result.unwrap(await scope.sdk.plugin(node).config.get())
		expect(await scope.sdk.plugin(node).config.validate({ set: { count: 'wrong' } })).toMatchObject(
			{
				status: 'error',
				error: {
					code: 'validation_failed',
					errors: { _root: { count: [{ message: 'count must be a number', path: ['count'] }] } },
				},
			},
		)
		await scope.sdk
			.plugin(node)
			.config.patch({ set: { count: 8 } }, { expectedManagedRevision: saved.managedRevision })
		expect(
			await scope.sdk
				.plugin(node)
				.config.patch({ set: { count: 16 } }, { expectedManagedRevision: saved.managedRevision }),
		).toMatchObject({ status: 'error', error: { code: 'revision_conflict', state: 'unchanged' } })
		expect(Result.unwrap(await scope.sdk.plugin(node).config.reset())).toMatchObject({
			config: { count: 2 },
			application: 'applied',
		})
		Result.unwrap(await scope.sdk.plugin(node).restart())
		Result.unwrap(await scope.sdk.plugin(node).stop())
		expect(Result.unwrap(await scope.sdk.plugins.list())).toMatchObject([
			{ address: node, lifecycleState: 'stopped' },
		])
	} finally {
		await scope.dispose()
	}
})

it('preserves shadowed raw inputs, source facts and readonly rejection', async () => {
	const node = Counter.nodeAddress()
	await using host = await createHost({
		plugins: [Counter],
		config: { mode: 'declared-only', records: [{ owner: node, config: { count: 7 } }] },
		runtime: { documents: { state: false, config: false } },
	})
	await host.start()
	const scope = createScriptScope({ ctx: host.ctx })
	try {
		expect(
			Result.unwrap(await scope.sdk.plugin(node).config.patch({ set: { count: 100 } })),
		).toMatchObject({
			managedInput: { count: 100 },
			effectiveInput: { count: 7 },
			config: { count: 7 },
			shadowedPaths: [['count']],
			sources: [{ kind: 'declaration', path: ['count'] }],
		})
		const initial = Result.unwrap(await scope.sdk.policy.get())
		expect(Result.unwrap(await scope.sdk.policy.validate({ startTimeoutMs: 4000 }))).toMatchObject({
			persistence: { status: 'unchanged' },
		})
		expect(Result.unwrap(await scope.sdk.policy.get())).toMatchObject({ managedInput: {} })
		expect(
			Result.unwrap(
				await scope.sdk.policy.patch(
					{ startTimeoutMs: 4000 },
					{ expectedManagedRevision: initial.managedRevision },
				),
			),
		).toMatchObject({
			managedInput: { startTimeoutMs: 4000 },
			pendingExecutionFields: ['startTimeoutMs'],
			appliedExecution: { startTimeoutMs: 1500 },
		})
		expect(
			await scope.sdk.policy.reset(undefined, { expectedManagedRevision: initial.managedRevision }),
		).toMatchObject({ status: 'error', error: { code: 'revision_conflict' } })
	} finally {
		await scope.dispose()
	}
	await using readonly = await createHost({
		plugins: [Counter],
		runtime: { documents: { config: { readOnly: true }, state: { readOnly: true } } },
	})
	await readonly.start()
	const locked = createScriptScope({ ctx: readonly.ctx })
	try {
		expect(await locked.sdk.plugin(node).config.patch({ set: { count: 3 } })).toMatchObject({
			status: 'error',
			error: {
				code: 'mutation_rejected',
				state: 'unchanged',
			},
		})
		expect(await locked.sdk.policy.patch({ startConcurrency: 2 })).toMatchObject({
			status: 'error',
			error: {
				code: 'mutation_rejected',
			},
		})
	} finally {
		await locked.dispose()
	}
})

it('injects the shared Result namespace and short-circuits a real CAS conflict without rolling back prior changes', async () => {
	await using host = await createHost({
		plugins: [Counter],
		runtime: { documents: { config: false, state: false } },
	})
	await host.start()
	await host.startNode(Counter.nodeAddress())
	const scope = createScriptScope({ ctx: host.ctx })
	try {
		expect(scope.sdk.Result).toBe(Result)
		const selected = scope.sdk.plugin(Counter.nodeAddress())
		const initial = await selected.config.get()
		expect(initial).toBeInstanceOf(Ok)
		const before = initial.unwrap()
		expect(before).not.toHaveProperty('ok')
		let reachedFinalMutation = false
		const outcome = await scope.sdk.Result.gen(async function* () {
			yield* scope.sdk.Result.await(selected.config.patch({ set: { count: 4 } }))
			yield* scope.sdk.Result.await(
				selected.config.patch(
					{ set: { count: 8 } },
					{ expectedManagedRevision: before.managedRevision },
				),
			)
			reachedFinalMutation = true
			yield* scope.sdk.Result.await(selected.config.patch({ set: { count: 999 } }))
			return scope.sdk.Result.ok('complete')
		})
		expect(outcome).toBeInstanceOf(Err)
		expect(outcome).toMatchObject({
			status: 'error',
			error: { code: 'revision_conflict', state: 'unchanged' },
		})
		if (outcome.isOk()) throw new Error('Expected a stale managed revision to short-circuit')
		expect(Object.getPrototypeOf(outcome.error)).toBe(Object.prototype)
		expect(outcome.error).not.toHaveProperty('ok')
		expect(reachedFinalMutation).toBe(false)
		const after = Result.unwrap(await selected.config.get())
		expect(after).toMatchObject({ config: { count: 4 }, application: 'applied' })
		expect(after.managedRevision).not.toBe(before.managedRevision)
		expect(requirePluginService(host.ctx).getInstance(Counter.nodeAddress())).toMatchObject({
			count: 4,
		})
	} finally {
		await scope.dispose()
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

it('keeps saved-but-not-applied and lifecycle failures as domain results', async () => {
	await using host = await createHost({ plugins: [RejectConfig, Broken] })
	await host.start()
	const scope = createScriptScope({ ctx: host.ctx })
	try {
		Result.unwrap(await scope.sdk.plugin(RejectConfig.nodeAddress()).start())
		expect(
			Result.unwrap(
				await scope.sdk.plugin(RejectConfig.nodeAddress()).config.patch({ set: { count: 5 } }),
			),
		).toMatchObject({
			config: { count: 5 },
			application: 'saved-not-applied',
			persistence: { status: 'confirmed' },
			applyFailure: { code: 'listener_failed' },
		})
		expect(
			(requirePluginService(host.ctx).getInstance(RejectConfig.nodeAddress()) as RejectConfig)
				.config,
		).toMatchObject({ count: 2 })
		expect(await scope.sdk.plugin(Broken.nodeAddress()).start()).toMatchObject({
			status: 'error',
			error: {
				code: 'lifecycle_failed',
				report: {
					core: {
						status: 'committed',
						summary: {
							lifecycleReport: {
								ok: false,
								issues: [{ plugin: Broken.nodeAddress(), error: { message: 'startup refused' } }],
							},
						},
					},
				},
			},
		})
		expect(Result.unwrap(await scope.sdk.plugin(Broken.nodeAddress()).status())).toMatchObject({
			lifecycleState: 'stopped',
		})
		expect(Result.unwrap(await scope.sdk.updates.latest())).toBeNull()
	} finally {
		await scope.dispose()
	}
})

it('does not publish a configuration whose persistence acknowledgement failed', async () => {
	const storage = createDocumentStorage()
	await using host = await createHost({
		plugins: [Counter],
		runtime: { documents: { config: { storage: () => storage }, state: false } },
	})
	await host.start()
	const scope = createScriptScope({ ctx: host.ctx })
	try {
		const before = await scope.snapshot()
		storage.put = async () => {
			throw new Error('write acknowledgement lost')
		}
		expect(
			await scope.sdk.plugin(Counter.nodeAddress()).config.patch({ set: { count: 10 } }),
		).toMatchObject({
			status: 'error',
			error: {
				code: 'persistence_failed',
				state: 'unknown',
				persistence: { status: 'unknown' },
			},
		})
		expect(Result.unwrap(await scope.sdk.plugin(Counter.nodeAddress()).config.get())).toMatchObject(
			{
				managedInput: null,
				config: { count: 2 },
			},
		)
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

it('closes cached admission on cancellation and drains a real accepted Host mutation', async () => {
	startup = Promise.withResolvers<void>()
	finishStartup = Promise.withResolvers<void>()
	await using host = await createHost({ plugins: [Delayed] })
	await host.start()
	const controller = new AbortController()
	const scope = createScriptScope({ ctx: host.ctx, signal: controller.signal })
	const cached = scope.sdk.plugins.list
	const admitted = scope.sdk.plugin(Delayed.nodeAddress()).start()
	await startup.promise
	controller.abort(new Error('user cancelled'))
	await expect(cached()).resolves.toMatchObject({
		status: 'error',
		error: { code: 'scope_closed' },
	})
	let disposed = false
	const disposal = scope.dispose().then((): void => {
		disposed = true
		return undefined
	})
	expect(disposed).toBe(false)
	finishStartup.resolve()
	await admitted
	await disposal
	expect(disposed).toBe(true)
	expect(requirePluginService(host.ctx).isRunning(Delayed.nodeAddress())).toBe(true)
	expect(scope.dispose()).toBe(scope.dispose())
	expect(await scope.snapshot()).toMatchObject({
		catalogRevision: expect.any(Number),
		configManagedRevision: expect.any(String),
		policyManagedRevision: expect.any(String),
	})
	const next = createScriptScope({ ctx: host.ctx })
	try {
		expect(Result.unwrap(await next.sdk.plugin(Delayed.nodeAddress()).status())).toMatchObject({
			lifecycleState: 'running',
		})
	} finally {
		await next.dispose()
	}
})

it('reads real bounded logging streams, waits with a deadline and preserves retention gaps', async () => {
	await using host = await createHost({
		plugins: [Counter],
		runtime: {
			logtape: logtape(({ createRuntimeLogSink }) => ({
				sinks: { history: createRuntimeLogSink({ windowLines: 2 }) },
				loggers: [
					{ category: ['pluxel'], lowestLevel: 'trace', sinks: ['history'] },
					{ category: ['logtape', 'meta'], lowestLevel: 'fatal', sinks: [] },
				],
			})),
		},
	})
	await host.start()
	const scope = createScriptScope({ ctx: host.ctx })
	try {
		const streams = Result.unwrap(await scope.sdk.logs.streams())
		expect(streams.streams).toMatchObject([{ streamId: 'default', retention: { windowLines: 2 } }])
		const cursor = Result.unwrap(await scope.sdk.logs.mark())
		for (const invalid of [
			{ cursor: { ...cursor, rootId: 'other-host' }, code: 'root_mismatch' },
			{ cursor: { ...cursor, bootId: 'replaced-stream' }, code: 'stream_replaced' },
			{ cursor: { ...cursor, streamId: 'unconfigured-stream' }, code: 'store_unavailable' },
		]) {
			const rejected = await scope.sdk.logs.read(invalid.cursor)
			expect(rejected).toMatchObject({
				status: 'error',
				error: { code: invalid.code, message: expect.any(String) },
			})
			if (rejected.isOk()) throw new Error('Expected the cursor to be rejected')
			expect(rejected.error.message).not.toBe('')
			expect(Object.isFrozen(rejected.error)).toBe(true)
		}
		Result.unwrap(await scope.sdk.plugin(Counter.nodeAddress()).start())
		expect(
			Result.unwrap(
				await scope.sdk.logs.read(cursor, { filter: { plugin: Counter.nodeAddress() } }),
			),
		).toMatchObject({ lines: [{ msg: 'counter started' }] })
		const end = Result.unwrap(await scope.sdk.logs.mark())
		expect(Result.unwrap(await scope.sdk.logs.wait(end, { timeoutMs: 5 }))).toMatchObject({
			lines: [],
		})
		const waiting = scope.sdk.logs.wait(end, {
			timeoutMs: 1000,
			filter: { category: 'pluxel.runtime.*' },
		})
		await Promise.resolve()
		host.ctx.logger.info('new diagnostic')
		host.ctx.logging!.flushStores()
		expect(Result.unwrap(await waiting)).toMatchObject({ lines: [{ msg: 'new diagnostic' }] })
		for (let i = 0; i < 5; i++) host.ctx.logger.info('retained {i}', { i })
		expect(await scope.sdk.logs.read(cursor)).toMatchObject({
			status: 'error',
			error: { code: 'from_too_old' },
		})
		await expect(scope.sdk.logs.read(end, { limit: 10001 })).rejects.toThrow('1 to 10000')
		const after = Result.unwrap(await scope.sdk.logs.mark())
		const pending = scope.sdk.logs.wait(after, { timeoutMs: 1000 })
		await Promise.resolve()
		expect(host.ctx.logging!.stores.get('default')!.subscriberCount).toBe(1)
		scope.abort(new Error('cancel log wait'))
		await expect(pending).resolves.toMatchObject({
			status: 'error',
			error: { code: 'cancelled' },
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
		await expect(scope.sdk.logs.streams()).resolves.toMatchObject({
			status: 'error',
			error: { code: 'logging_unavailable' },
		})
		expect(host.ctx.logging).toBeUndefined()
	} finally {
		await scope.dispose()
	}
	await using logs = await createHost({
		plugins: [],
		runtime: {
			logtape: { sinks: {}, loggers: [{ category: [], lowestLevel: 'fatal', sinks: [] }] },
		},
	})
	const noHistory = createScriptScope({ ctx: logs.ctx })
	try {
		expect(Result.unwrap(await noHistory.sdk.logs.streams())).toMatchObject({ streams: [] })
		await expect(noHistory.sdk.logs.mark()).resolves.toMatchObject({
			status: 'error',
			error: { code: 'store_unavailable' },
		})
		expect(logs.ctx.logging!.stores.list()).toEqual([])
	} finally {
		await noHistory.dispose()
	}
})
