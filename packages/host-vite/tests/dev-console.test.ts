import { BasePlugin, Plugin } from '@pluxel/core'
import { createHost } from '@pluxel/host'
import { lowerTestReplacement } from '@pluxel/test/unsafe'
import { expect, it } from 'vitest'
import { createDevConsoleScope } from '../src/dev/console'
import { DevScope } from '../src/dev/scope'
import { defineDevConsole } from '../src/console'
import { snapshotJson } from '../src/console/protocol'

const schema = {
	'~standard': {
		version: 1 as const,
		vendor: 'console-test',
		types: undefined as { input: Record<string, unknown>; output: { label: string } } | undefined,
		validate(input: unknown) {
			const label = (input as { label?: unknown })?.label ?? 'initial'
			return typeof label === 'string'
				? { value: { label } }
				: { issues: [{ message: 'label must be a string', path: ['label'] }] }
		},
	},
}
@Plugin()
class Counter extends BasePlugin {
	readonly config = this.configs.use(schema)
	count = 0
	label = 'initial'
	init() {
		this.configs.onUpdate(this.config, ({ desired }) => {
			this.label = desired.label
		})
	}
}

it('borrows a Host without official services, retains state, and exposes its baseline logger', async () => {
	const host = await createHost({ plugins: [Counter] })
	await host.start()
	const scope = createDevConsoleScope({ id: 'test', ctx: host.ctx })
	try {
		const { dev } = scope
		expect(dev.ctx).toBe(host.ctx)
		expect(dev.ctx.logger).toBeDefined()
		dev.ctx.logger.info('Console with no configured logging service')
		expect(await dev.plugins.list()).toMatchObject([{ lifecycleState: 'stopped' }])
		await dev.plugins.start(Counter)
		const first = dev.plugins.require(Counter)
		first.count = 4
		expect(await dev.plugins.status(Counter)).toMatchObject({ lifecycleState: 'running' })
		expect(() => dev.plugins.require(Counter.nodeAddress() as never)).toThrow(TypeError)
		await scope.dispose()
		await expect(dev.plugins.list()).rejects.toMatchObject({ code: 'scope_closed' })
		expect(() => dev.ctx).toThrow(expect.objectContaining({ code: 'scope_closed' }))
		const next = createDevConsoleScope({ id: 'test', ctx: host.ctx })
		try {
			expect(next.dev.plugins.require(Counter)).toBe(first)
			expect(next.dev.plugins.require(Counter).count).toBe(4)
			await next.dev.plugins.stop(Counter)
			expect(next.dev.plugins.isRunning(Counter)).toBe(false)
			await next.dev.plugins.start(Counter)
			expect(next.dev.plugins.require(Counter)).not.toBe(first)
		} finally {
			await next.dispose()
		}
	} finally {
		await scope.dispose()
		await host.close()
	}
})

it('validates and changes Host config without Management or persistence services', async () => {
	const host = await createHost({ plugins: [Counter] })
	await host.start()
	const scope = createDevConsoleScope({ id: 'test', ctx: host.ctx })
	try {
		await scope.dev.plugins.start(Counter)
		expect(await scope.dev.config.get(Counter)).toMatchObject({
			ok: true,
			managedInput: null,
			effectiveInput: {},
			config: { label: 'initial' },
		})
		expect(await scope.dev.config.validate(Counter, { set: { label: 3 } })).toMatchObject({
			ok: false,
			code: 'validation_failed',
		})
		expect(
			snapshotJson(await scope.dev.config.patch(Counter, { set: { label: 'changed' } })),
		).toMatchObject({
			ok: true,
			persistence: { status: 'confirmed' },
			application: 'applied',
		})
		expect(await scope.dev.config.get(Counter)).toMatchObject({ config: { label: 'changed' } })
		expect(scope.dev.plugins.require(Counter).label).toBe('changed')
		expect(await scope.dev.config.reset(Counter)).toMatchObject({
			ok: true,
			config: { label: 'initial' },
		})
	} finally {
		await scope.dispose()
		await host.close()
	}
})

it('inspects saved values and runtime declarations through the console without writing', async () => {
	const owner = Counter.nodeAddress()
	const host = await createHost({
		plugins: [Counter],
		config: {
			mode: 'declared-only',
			records: [{ owner, config: { label: 'declared' } }],
		},
		policy: { autoStart: [], mode: { autoStart: 'declared-only' } },
		runtime: { documents: { state: false, config: false } },
	})
	await host.start()
	const scope = createDevConsoleScope({ id: 'inspect', ctx: host.ctx })
	try {
		expect(snapshotJson(await scope.dev.config.inspect(Counter))).toMatchObject({
			mode: 'declared-only',
			readonly: false,
			externalReload: false,
			managedInput: null,
			declared: { label: 'declared' },
			effectiveInput: { label: 'declared' },
			sources: [{ kind: 'declaration', path: ['label'] }],
		})
		expect(snapshotJson(await scope.dev.policy.get())).toMatchObject({
			mode: { autoStart: 'declared-only' },
			managedInput: {},
			effective: { autoStart: [] },
		})
		expect(await scope.dev.config.patch(Counter, { set: { label: 'blocked' } })).toMatchObject({
			ok: true,
			managedInput: { label: 'blocked' },
			config: { label: 'declared' },
		})
		await scope.dispose()
		await expect(scope.dev.config.inspect(Counter)).rejects.toMatchObject({ code: 'scope_closed' })
		await expect(scope.dev.policy.get()).rejects.toMatchObject({ code: 'scope_closed' })
	} finally {
		await scope.dispose()
		await host.close()
	}
})

@Plugin({ forkable: true })
class Forkable extends BasePlugin {}

it('edits saved execution policy through the console and rejects stale edit baselines', async () => {
	await using host = await createHost({
		plugins: [],
		runtime: { documents: { state: false } },
	})
	await host.start()
	const scope = createDevConsoleScope({ id: 'policy', ctx: host.ctx })
	try {
		const baseline = await scope.dev.policy.get()
		if (baseline.ok === false) throw new Error(baseline.message)
		expect(await scope.dev.policy.validate({ startTimeoutMs: 4_000 })).toMatchObject({
			ok: true,
			persistence: { status: 'unchanged' },
		})
		expect(await scope.dev.policy.get()).toMatchObject({ managedInput: {} })
		expect(
			await scope.dev.policy.patch(
				{ startTimeoutMs: 4_000 },
				{ expectedManagedRevision: baseline.managedRevision },
			),
		).toMatchObject({
			ok: true,
			managedInput: { startTimeoutMs: 4_000 },
			effective: { startTimeoutMs: 4_000 },
			appliedExecution: { startTimeoutMs: 1_500 },
			pendingExecutionFields: ['startTimeoutMs'],
			persistence: { status: 'confirmed', retention: 'session' },
		})
		expect(
			await scope.dev.policy.reset(undefined, {
				expectedManagedRevision: baseline.managedRevision,
			}),
		).toMatchObject({ ok: false, code: 'revision_conflict' })
	} finally {
		await scope.dispose()
	}
	await expect(scope.dev.policy.get()).rejects.toMatchObject({ code: 'scope_closed' })
})

it('borrows an existing typed fork and preserves it after the run closes', async () => {
	const host = await createHost({ plugins: [Forkable] })
	await host.start()
	const scope = createDevConsoleScope({ id: 'test', ctx: host.ctx })
	const fork = { plugin: Forkable, forkId: 'east' }
	try {
		expect(await host.forks.ensure(Forkable.nodeAddress(fork.forkId))).toMatchObject({
			ok: true,
		})
		await scope.dev.plugins.start(fork)
		const instance = scope.dev.plugins.require(fork)
		await scope.dispose()
		const next = createDevConsoleScope({ id: 'test', ctx: host.ctx })
		try {
			expect(next.dev.plugins.require(fork)).toBe(instance)
		} finally {
			await next.dispose()
		}
	} finally {
		await scope.dispose()
		await host.close()
	}
})

@Plugin()
class Replaceable extends BasePlugin {}

it('rejects a constructor superseded by the live Host catalog', async () => {
	const host = await createHost({ plugins: [Replaceable] })
	await host.start()
	const scope = createDevConsoleScope({ id: 'test', ctx: host.ctx })
	try {
		await scope.dev.plugins.start(Replaceable)
		const replacement = lowerTestReplacement(Replaceable, class extends Replaceable {})
		await host.updateCatalog([replacement])
		expect(() => scope.dev.plugins.require(Replaceable)).toThrow(
			expect.objectContaining({ code: 'stale_target' }),
		)
		expect(await scope.dev.plugins.status(Replaceable.nodeAddress())).toMatchObject({
			lifecycleState: 'running',
		})
	} finally {
		await scope.dispose()
		await host.close()
	}
})

it('closes admission immediately and drains admitted operations before disposal completes', async () => {
	const scope = new DevScope()
	const work = Promise.withResolvers<void>()
	const admitted = scope.run(() => work.promise)
	await Promise.resolve()
	let finished = false
	const disposal = scope.dispose().then((): void => {
		finished = true
		return undefined
	})
	await expect(scope.run(() => 1)).rejects.toMatchObject({ code: 'scope_closed' })
	expect(finished).toBe(false)
	work.resolve()
	await admitted
	await disposal
	expect(finished).toBe(true)
})

@Plugin()
class Broken extends BasePlugin {
	init() {
		throw new Error('console start failed')
	}
}

it('returns serializable lifecycle failures without mistaking a commit for successful startup', async () => {
	const host = await createHost({ plugins: [Broken] })
	await host.start()
	const scope = createDevConsoleScope({ id: 'failure', input: { requested: true }, ctx: host.ctx })
	try {
		let invoked = false
		const script = defineDevConsole(async (dev) => {
			invoked = true
			expect(dev.id).toBe('failure')
			expect(dev.input).toEqual({ requested: true })
			expect(dev.signal.aborted).toBe(false)
			expect(await dev.updates.latest()).toBeNull()
			return dev.plugins.start(Broken)
		})
		expect(invoked).toBe(false)
		const report = snapshotJson(await script(scope.dev))
		expect(report).toMatchObject({
			core: {
				status: 'committed',
				summary: {
					lifecycleReport: {
						ok: false,
						issues: [{ plugin: Broken.nodeAddress(), error: { message: 'console start failed' } }],
					},
				},
			},
		})
		expect(scope.dev.plugins.isRunning(Broken)).toBe(false)
	} finally {
		await scope.dispose()
		await host.close()
	}
})

@Plugin()
class RejectConfig extends BasePlugin {
	readonly config = this.configs.use(schema)
	init() {
		this.configs.onUpdate(this.config, () => {
			throw new Error('config listener failed')
		})
	}
}

it('preserves saved-but-not-applied configuration in the portable result', async () => {
	const host = await createHost({ plugins: [RejectConfig] })
	await host.start()
	const scope = createDevConsoleScope({ id: 'config', ctx: host.ctx })
	try {
		await scope.dev.plugins.start(RejectConfig)
		expect(
			snapshotJson(await scope.dev.config.patch(RejectConfig, { set: { label: 'saved' } })),
		).toMatchObject({
			ok: true,
			persistence: { status: 'confirmed' },
			application: 'saved-not-applied',
			applyFailure: { code: 'listener_failed' },
			config: { label: 'saved' },
		})
	} finally {
		await scope.dispose()
		await host.close()
	}
})
