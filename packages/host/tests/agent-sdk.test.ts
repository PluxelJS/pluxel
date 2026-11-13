import { BasePlugin, Plugin } from '@pluxel/core'
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
		await scope.sdk.plugins.start(node)
		const script = (async (sdk, run) => {
			run.signal.throwIfAborted()
			const before = await sdk.config.get(node)
			if (before.ok === false) return before
			const count = before.config.count
			if (typeof count !== 'number') throw new TypeError('Expected numeric count')
			const changed = await sdk.config.patch(
				node,
				{ set: { count: count * 2 } },
				{ expectedManagedRevision: before.managedRevision },
			)
			if (changed.ok === false) return changed
			return { changed, actual: await sdk.config.get(node), status: await sdk.plugins.status(node) }
		}) satisfies Script
		const result = await script(scope.sdk, {
			id: 'config-task',
			input: null,
			signal: new AbortController().signal,
		})
		expect(result).toMatchObject({
			changed: {
				ok: true,
				application: 'applied',
				persistence: { status: 'confirmed', retention: 'session' },
			},
			actual: { config: { count: 4 } },
			status: { lifecycleState: 'running' },
		})
		expect(requirePluginService(host.ctx).getInstance(node)).toMatchObject({ count: 4 })
		const saved = await scope.sdk.config.get(node)
		if (saved.ok === false) throw new Error(saved.message)
		expect(await scope.sdk.config.validate(node, { set: { count: 'wrong' } })).toMatchObject({
			ok: false,
			code: 'validation_failed',
			errors: { _root: { count: [{ message: 'count must be a number', path: ['count'] }] } },
		})
		await scope.sdk.config.patch(
			node,
			{ set: { count: 8 } },
			{ expectedManagedRevision: saved.managedRevision },
		)
		expect(
			await scope.sdk.config.patch(
				node,
				{ set: { count: 16 } },
				{ expectedManagedRevision: saved.managedRevision },
			),
		).toMatchObject({ ok: false, code: 'revision_conflict', state: 'unchanged' })
		expect(await scope.sdk.config.reset(node)).toMatchObject({
			ok: true,
			config: { count: 2 },
			application: 'applied',
		})
		await scope.sdk.plugins.restart(node)
		await scope.sdk.plugins.stop(node)
		expect(await scope.sdk.plugins.list()).toMatchObject([
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
		expect(await scope.sdk.config.patch(node, { set: { count: 100 } })).toMatchObject({
			ok: true,
			managedInput: { count: 100 },
			effectiveInput: { count: 7 },
			config: { count: 7 },
			shadowedPaths: [['count']],
			sources: [{ kind: 'declaration', path: ['count'] }],
		})
		const initial = await scope.sdk.policy.get()
		if (initial.ok === false) throw new Error(initial.message)
		expect(await scope.sdk.policy.validate({ startTimeoutMs: 4000 })).toMatchObject({
			ok: true,
			persistence: { status: 'unchanged' },
		})
		expect(await scope.sdk.policy.get()).toMatchObject({ managedInput: {} })
		expect(
			await scope.sdk.policy.patch(
				{ startTimeoutMs: 4000 },
				{ expectedManagedRevision: initial.managedRevision },
			),
		).toMatchObject({
			ok: true,
			managedInput: { startTimeoutMs: 4000 },
			pendingExecutionFields: ['startTimeoutMs'],
			appliedExecution: { startTimeoutMs: 1500 },
		})
		expect(
			await scope.sdk.policy.reset(undefined, { expectedManagedRevision: initial.managedRevision }),
		).toMatchObject({ ok: false, code: 'revision_conflict' })
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
		expect(await locked.sdk.config.patch(node, { set: { count: 3 } })).toMatchObject({
			ok: false,
			code: 'mutation_rejected',
			state: 'unchanged',
		})
		expect(await locked.sdk.policy.patch({ startConcurrency: 2 })).toMatchObject({
			ok: false,
			code: 'mutation_rejected',
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

it('keeps saved-but-not-applied and lifecycle failures as domain results', async () => {
	await using host = await createHost({ plugins: [RejectConfig, Broken] })
	await host.start()
	const scope = createScriptScope({ ctx: host.ctx })
	try {
		await scope.sdk.plugins.start(RejectConfig.nodeAddress())
		expect(
			await scope.sdk.config.patch(RejectConfig.nodeAddress(), { set: { count: 5 } }),
		).toMatchObject({
			ok: true,
			config: { count: 5 },
			application: 'saved-not-applied',
			persistence: { status: 'confirmed' },
			applyFailure: { code: 'listener_failed' },
		})
		expect(
			(requirePluginService(host.ctx).getInstance(RejectConfig.nodeAddress()) as RejectConfig)
				.config,
		).toMatchObject({ count: 2 })
		expect(await scope.sdk.plugins.start(Broken.nodeAddress())).toMatchObject({
			core: {
				status: 'committed',
				summary: {
					lifecycleReport: {
						ok: false,
						issues: [{ plugin: Broken.nodeAddress(), error: { message: 'startup refused' } }],
					},
				},
			},
		})
		expect(await scope.sdk.plugins.status(Broken.nodeAddress())).toMatchObject({
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
			await scope.sdk.config.patch(Counter.nodeAddress(), { set: { count: 10 } }),
		).toMatchObject({
			ok: false,
			code: 'persistence_failed',
			state: 'unknown',
			persistence: { status: 'unknown' },
		})
		expect(await scope.sdk.config.get(Counter.nodeAddress())).toMatchObject({
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

it('closes cached admission on cancellation and drains a real accepted Host mutation', async () => {
	startup = Promise.withResolvers<void>()
	finishStartup = Promise.withResolvers<void>()
	await using host = await createHost({ plugins: [Delayed] })
	await host.start()
	const controller = new AbortController()
	const scope = createScriptScope({ ctx: host.ctx, signal: controller.signal })
	const cached = scope.sdk.plugins.list
	const admitted = scope.sdk.plugins.start(Delayed.nodeAddress())
	await startup.promise
	controller.abort(new Error('user cancelled'))
	await expect(cached()).rejects.toMatchObject({ code: 'scope_closed' })
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
		expect(await next.sdk.plugins.status(Delayed.nodeAddress())).toMatchObject({
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
		const streams = await scope.sdk.logs.streams()
		expect(streams.streams).toMatchObject([{ streamId: 'default', retention: { windowLines: 2 } }])
		const cursor = await scope.sdk.logs.mark()
		await scope.sdk.plugins.start(Counter.nodeAddress())
		expect(
			await scope.sdk.logs.read(cursor, { filter: { plugin: Counter.nodeAddress() } }),
		).toMatchObject({ ok: true, lines: [{ msg: 'counter started' }] })
		const end = await scope.sdk.logs.mark()
		expect(await scope.sdk.logs.wait(end, { timeoutMs: 5 })).toMatchObject({ ok: true, lines: [] })
		const waiting = scope.sdk.logs.wait(end, {
			timeoutMs: 1000,
			filter: { category: 'pluxel.runtime.*' },
		})
		await Promise.resolve()
		host.ctx.logger.info('new diagnostic')
		host.ctx.logging!.flushStores()
		expect(await waiting).toMatchObject({ ok: true, lines: [{ msg: 'new diagnostic' }] })
		for (let i = 0; i < 5; i++) host.ctx.logger.info('retained {i}', { i })
		expect(await scope.sdk.logs.read(cursor)).toMatchObject({ ok: false, code: 'from_too_old' })
		await expect(scope.sdk.logs.read(end, { limit: 10001 })).rejects.toThrow('1 to 10000')
		const after = await scope.sdk.logs.mark()
		const pending = scope.sdk.logs.wait(after, { timeoutMs: 1000 })
		await Promise.resolve()
		expect(host.ctx.logging!.stores.get('default')!.subscriberCount).toBe(1)
		scope.abort(new Error('cancel log wait'))
		await expect(pending).rejects.toThrow('cancel log wait')
		expect(host.ctx.logging!.stores.get('default')!.subscriberCount).toBe(0)
	} finally {
		await scope.dispose()
	}
})

it('reports missing history capabilities without installing a logging backend', async () => {
	await using host = await createHost({ plugins: [] })
	const scope = createScriptScope({ ctx: host.ctx })
	try {
		await expect(scope.sdk.logs.streams()).rejects.toMatchObject({ code: 'logging_unavailable' })
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
		expect(await noHistory.sdk.logs.streams()).toMatchObject({ streams: [] })
		await expect(noHistory.sdk.logs.mark()).rejects.toMatchObject({ code: 'store_unavailable' })
		expect(logs.ctx.logging!.stores.list()).toEqual([])
	} finally {
		await noHistory.dispose()
	}
})
