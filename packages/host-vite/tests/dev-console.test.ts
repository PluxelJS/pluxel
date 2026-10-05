import { BasePlugin, Plugin, pluginNodeAddressOf } from '@pluxel/core'
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
		expect(() => dev.plugins.require(pluginNodeAddressOf(Counter) as never)).toThrow(TypeError)
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
			defaults: { label: 'initial' },
		})
		expect(await scope.dev.config.validate(Counter, { label: 3 })).toMatchObject({
			ok: false,
			code: 'validation_failed',
		})
		expect(snapshotJson(await scope.dev.config.patch(Counter, { label: 'changed' }))).toMatchObject(
			{
				ok: true,
				saved: true,
				application: 'applied',
			},
		)
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

@Plugin({ forkable: true })
class Forkable extends BasePlugin {}

it('borrows an existing typed fork and preserves it after the run closes', async () => {
	const host = await createHost({ plugins: [Forkable] })
	await host.start()
	const scope = createDevConsoleScope({ id: 'test', ctx: host.ctx })
	const fork = { plugin: Forkable, forkId: 'east' }
	try {
		expect(await host.forks.ensure(pluginNodeAddressOf(Forkable), fork.forkId)).toMatchObject({
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
		expect(await scope.dev.plugins.status(pluginNodeAddressOf(Replaceable))).toMatchObject({
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
	const disposal = scope.dispose().then(() => {
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
						issues: [
							{ plugin: pluginNodeAddressOf(Broken), error: { message: 'console start failed' } },
						],
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
			snapshotJson(await scope.dev.config.patch(RejectConfig, { label: 'saved' })),
		).toMatchObject({
			ok: true,
			saved: true,
			application: 'saved-not-applied',
			applyFailure: { code: 'listener_failed' },
			config: { label: 'saved' },
		})
	} finally {
		await scope.dispose()
		await host.close()
	}
})
