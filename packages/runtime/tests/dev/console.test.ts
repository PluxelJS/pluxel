import { pluginNodeAddressOf } from '@pluxel/core'
import {
	createRuntimeInternalTestHost,
	createRuntimeInternalTestHarness,
} from '@pluxel/runtime/internal/test'
import { BasePlugin, Plugin, definePluginFork } from '@pluxel/runtime/test'
import { lowerTestReplacement } from '@pluxel/test/unsafe'
import { RpcTarget } from '@pluxel/runtime/capnweb'
import { workbench } from '@pluxel/runtime/workbench'
import { describe, it, expect, vi } from 'vitest'
import { LoggerService } from '@pluxel/core/logger'
import { v } from '../../src/config'
import { createDevConsoleScope } from '../../src/internal/dev-console'
import { DevScope } from '../../src/dev/scope'
import { createRuntimeLogging } from '../../src/logger/logging'

const Config = v.object({
	label: v.optional(v.string(), 'initial'),
	nested: v.optional(v.object({ count: v.optional(v.number(), 1) }), {}),
})
@Plugin({ forkable: true })
class Counter extends BasePlugin {
	readonly config = this.configs.use(Config)
	label = ''
	count = 0
	override init() {
		this.label = this.config.label
		this.configs.onUpdate(this.config, ({ desired }) => {
			this.label = desired.label
		})
	}
	add(value: number) {
		return (this.count += value)
	}
}
@Plugin({ forkable: true })
class Forkable extends BasePlugin {}
@Plugin()
class Failing extends BasePlugin {
	override init() {
		throw new Error('intentional failure')
	}
}

@Plugin()
class Streaming extends BasePlugin {
	response = new Response(null)
	override init() {
		this.ctx.elysia.get('/stream', () => this.response)
	}
}

interface PanelApi extends RpcTarget {
	add(value: number): number
}
const UI = workbench.define({
	panel: workbench.view<PanelApi>({
		renderer: workbench.entry(import.meta.url, '../workbench/fixtures/settings.tsx'),
		placement: workbench.tab({ label: 'Panel' }),
	}),
})
const released = vi.fn()
class PanelTarget extends RpcTarget implements PanelApi {
	constructor(private readonly owner: PanelPlugin) {
		super()
	}
	add(value: number) {
		return (this.owner.count += value)
	}
	[Symbol.dispose]() {
		released()
	}
}
@Plugin()
class PanelPlugin extends BasePlugin {
	count = 0
	override init() {
		this.ctx.workbench?.publish(UI, { panel: () => new PanelTarget(this) })
	}
}

describe('development console', () => {
	it('borrows the live world across runs and returns production lifecycle reports', async () => {
		await using host = createRuntimeInternalTestHost()
		const first = await host.start(Counter)
		const scope = createDevConsoleScope({ ctx: host.ctx })
		const { dev } = scope
		expect(dev.plugins.require(Counter)).toBe(first)
		expect(() => dev.plugins.require(pluginNodeAddressOf(Counter) as never)).toThrow(TypeError)
		dev.plugins.require(Counter).add(4)
		expect(await dev.plugins.status(Counter)).toMatchObject({ lifecycleState: 'running' })
		expect(await dev.plugins.stop(Counter)).toMatchObject({ ok: true, report: expect.any(Object) })
		expect(() => dev.plugins.require(Counter)).toThrow(
			expect.objectContaining({ code: 'plugin_not_running' }),
		)
		expect(await dev.plugins.start(Counter)).toMatchObject({ ok: true })
		const current = dev.plugins.require(Counter)
		expect(current).not.toBe(first)
		current.add(8)
		await scope.dispose()
		expect(host.require(Counter).count).toBe(8)
		await expect(dev.plugins.list()).rejects.toMatchObject({ code: 'scope_closed' })
		const second = createDevConsoleScope({ ctx: host.ctx })
		expect(second.dev.plugins.require(Counter)).toBe(current)
		await second.dispose()
	})

	it('edits and describes real configuration with validation and application state', async () => {
		await using host = createRuntimeInternalTestHost()
		await host.start(Counter)
		const scope = createDevConsoleScope({ ctx: host.ctx })
		try {
			const { config } = scope.dev
			expect(await config.get(Counter)).toMatchObject({ ok: true, defaults: { label: 'initial' } })
			expect(await config.describe(Counter)).toMatchObject({ ok: true, plan: expect.any(Object) })
			expect(await config.validate(Counter, { label: 4 })).toMatchObject({
				ok: false,
				code: 'validation_failed',
			})
			expect(await config.patch(Counter, { label: 'edited' })).toMatchObject({
				ok: true,
				saved: true,
				application: 'applied',
			})
			expect(host.require(Counter).label).toBe('edited')
			expect(
				await config.patchField(Counter, { fieldPath: 'nested.count', value: 7 }),
			).toMatchObject({ ok: true })
			expect(await config.get(Counter)).toMatchObject({ config: { nested: { count: 7 } } })
			expect(await config.reset(Counter, ['label'])).toMatchObject({ ok: true })
			expect(host.require(Counter).label).toBe('initial')
		} finally {
			await scope.dispose()
		}
	})

	it('accepts typed forks and addresses but rejects stale constructors', async () => {
		await using host = createRuntimeInternalTestHost()
		const fork = definePluginFork(Forkable, 'east')
		const instance = await host.start(fork)
		const scope = createDevConsoleScope({ ctx: host.ctx })
		try {
			expect(scope.dev.plugins.require({ plugin: Forkable, forkId: 'east' })).toBe(instance)
			const next = lowerTestReplacement(Forkable, class extends Forkable {}, {
				plugin: { forkable: true },
			})
			await host.replaceDefinition(Forkable, next)
			expect(() => scope.dev.plugins.require(Forkable)).toThrow(
				expect.objectContaining({ code: 'stale_target' }),
			)
			expect(
				await scope.dev.plugins.status({
					...pluginNodeAddressOf(Forkable),
					variant: 'fork',
					forkId: 'east',
				}),
			).toMatchObject({ lifecycleState: 'running' })
		} finally {
			await scope.dispose()
		}
	})

	it('retains a failed production start report without test assertions', async () => {
		await using host = createRuntimeInternalTestHost()
		await host.commit((change) => change.catalog.add(Failing))
		const scope = createDevConsoleScope({ ctx: host.ctx })
		try {
			const result = await scope.dev.plugins.start(Failing)
			expect(result).toMatchObject({ ok: true, report: { core: { status: 'committed' } } })
			expect(await scope.dev.plugins.status(Failing)).toMatchObject({ lifecycleState: 'stopped' })
		} finally {
			await scope.dispose()
		}
	})

	it('discovers and opens exact typed Workbench RPC, cleans leases without stopping the plugin', async () => {
		released.mockClear()
		await using host = createRuntimeInternalTestHost({ workbench: { enabled: true } })
		await host.start(PanelPlugin)
		const scope = createDevConsoleScope({ ctx: host.ctx })
		const principal = { provider: 'development', subject: 'agent' }
		const layout = await scope.dev.workbench.list({ target: PanelPlugin, principal })
		expect(layout.entries).toHaveLength(1)
		const opened = await scope.dev.workbench.open({
			target: PanelPlugin,
			entry: UI.panel,
			principal,
		})
		expect(await opened.api.add(9)).toBe(9)
		expect(host.require(PanelPlugin).count).toBe(9)
		await scope.dispose()
		expect(released).toHaveBeenCalledOnce()
		opened[Symbol.dispose]()
		expect(released).toHaveBeenCalledOnce()
		expect(host.isRunning(PanelPlugin)).toBe(true)
	})

	it('drains admitted work and asynchronous cleanup, and rejects new calls immediately', async () => {
		const scope = new DevScope()
		const work = Promise.withResolvers<void>()
		const cleanup = Promise.withResolvers<void>()
		const admitted = scope.run(() => work.promise)
		await Promise.resolve()
		scope.own(() => cleanup.promise)
		let finished = false
		const disposal = scope.dispose().then(() => {
			finished = true
			return undefined
		})
		await expect(scope.run(() => 1)).rejects.toMatchObject({ code: 'scope_closed' })
		work.resolve()
		await admitted
		expect(finished).toBe(false)
		cleanup.resolve()
		await disposal
		expect(finished).toBe(true)
	})

	it('waits for response body cancellation before publishing disposal completion', async () => {
		await using host = createRuntimeInternalTestHost()
		const cancellation = Promise.withResolvers<void>()
		const entered = Promise.withResolvers<void>()
		const response = new Response(
			new ReadableStream<Uint8Array>({
				cancel() {
					entered.resolve()
					return cancellation.promise
				},
			}),
		)
		const streaming = await host.start(Streaming)
		streaming.response = response
		const scope = createDevConsoleScope({ ctx: host.ctx })
		try {
			await scope.dev.http.fetch(new URL('/stream', scope.dev.http.origin))
			let disposed = false
			const disposal = scope.dispose().then(() => {
				disposed = true
				return undefined
			})
			await entered.promise
			expect(disposed).toBe(false)
			cancellation.resolve()
			await disposal
			expect(disposed).toBe(true)
		} finally {
			cancellation.resolve()
			await scope.dispose()
		}
	})

	it('passes cancellation to admitted production commands', async () => {
		await using host = createRuntimeInternalTestHost()
		const entered = Promise.withResolvers<AbortSignal>()
		const execute = vi.spyOn(host.ctx.commands, 'execute').mockImplementation(
			(_name, _input, context) =>
				new Promise((resolve) => {
					const signal = context!.signal!
					entered.resolve(signal)
					signal.addEventListener('abort', () => resolve('aborted'), { once: true })
				}),
		)
		const scope = createDevConsoleScope({ ctx: host.ctx })
		try {
			const call = scope.dev.commands.execute('test.pending', {})
			const signal = await entered.promise
			scope.abort()
			expect(signal.aborted).toBe(true)
			expect(await call).toBe('aborted')
			await scope.dispose()
		} finally {
			await scope.dispose()
			execute.mockRestore()
		}
	})

	it('flushes buffered logs and reports filtered pages, timeout, reset and abort', async () => {
		const logging = createRuntimeLogging({
			root: { profile: 'console-test' },
			sinks: {
				store: {
					kind: 'store',
					streamId: 'default',
					bufferSize: 1000,
					flushIntervalMs: 0,
					windowLines: 3,
					caller: false,
				},
			},
			routes: { runtime: [{ sink: 'store', minLevel: 'info' }], plugins: [], debug: [], meta: [] },
		})
		await logging.install()
		const host = createRuntimeInternalTestHarness({ workbench: false }, { logging })
		const scope = createDevConsoleScope({ ctx: host.ctx })
		try {
			const logger = new LoggerService(host.ctx, logging.contextBinding)
			const cursor = await scope.dev.logs.mark()
			logger.info('one')
			logger.info('two')
			const page = await scope.dev.logs.read({ cursor, limit: 1 })
			expect(page).toMatchObject({ ok: true, lines: [{ msg: 'one' }], hasMore: true })
			const skipped = await scope.dev.logs.wait({
				cursor,
				limit: 1,
				filter: { context: 'missing' },
				timeoutMs: 0,
			})
			expect(skipped).toMatchObject({
				reason: 'more',
				result: { ok: true, lines: [], hasMore: true },
			})
			expect(logging.stores.get('default')!.meta().retention.windowLines).toBe(3)
			const mark = await scope.dev.logs.mark()
			expect(await scope.dev.logs.wait({ cursor: mark, timeoutMs: 0 })).toMatchObject({
				reason: 'timeout',
			})
			expect(await scope.dev.logs.read({ cursor: { ...mark, bootId: 'old' } })).toMatchObject({
				ok: false,
				code: 'root_changed',
			})
			expect(
				await scope.dev.logs.read({ cursor: { ...mark, epoch: mark.epoch + 1 } }),
			).toMatchObject({ ok: false, code: 'epoch_mismatch' })
			const appended = scope.dev.logs.wait({ cursor: mark })
			await Promise.resolve()
			logger.info('three')
			logging.flushStores()
			expect(await appended).toMatchObject({
				reason: 'available',
				result: { lines: [{ msg: 'three' }] },
			})
			logger.info('four')
			expect(await scope.dev.logs.read({ cursor })).toMatchObject({
				ok: false,
				code: 'from_too_old',
			})
			logging.stores.get('default')!.reset()
			expect(await scope.dev.logs.read({ cursor: mark })).toMatchObject({
				ok: false,
				code: 'epoch_mismatch',
			})
			const resetCursor = await scope.dev.logs.mark()
			const controller = new AbortController()
			const waiting = scope.dev.logs.wait({ cursor: resetCursor, signal: controller.signal })
			await Promise.resolve()
			controller.abort(new Error('stop waiting'))
			await expect(waiting).rejects.toThrow('stop waiting')
		} finally {
			await scope.dispose()
			await host.dispose()
			await logging.dispose()
		}
	})
})
