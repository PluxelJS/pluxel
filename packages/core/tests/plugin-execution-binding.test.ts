import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { BasePlugin, Plugin, pluginNodeIndexKey } from '@pluxel/core'
import {
	assertPluginLifecycleIssue,
	createCoreInternalTestHost,
	type CoreInternalTestHostOptions,
} from '@pluxel/core/internal/test'
import { createCoreContextHost } from '../src/host'
import { createCorePluginExecutionBinding, requirePluginService } from '../src/internal'

function waitForAbort(signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
}

@Plugin({ forkable: true, startTimeoutMs: 25 })
class TimedPlugin extends BasePlugin {
	override init(signal: AbortSignal) {
		return waitForAbort(signal)
	}
}

let onDefaultPluginInit: ((signal: AbortSignal) => void) | undefined

@Plugin()
class DefaultTimeoutPlugin extends BasePlugin {
	override init(signal: AbortSignal) {
		const aborted = waitForAbort(signal)
		onDefaultPluginInit?.(signal)
		return aborted
	}
}

it('binds execution exactly once before the fixed PluginService is acquired', async () => {
	const executionBinding = createCorePluginExecutionBinding()
	const root = createCoreContextHost({ executionBinding }).createRoot()
	try {
		expect(() => requirePluginService(root)).toThrow('has not been bound')
		const values = { startTimeoutMs: 10_000 }
		executionBinding.bind(values)
		values.startTimeoutMs = 1
		expect(executionBinding.read().startTimeoutMs).toBe(10_000)
		expect(() => executionBinding.bind({})).toThrow('already bound')
		expect(requirePluginService(root)).toBe(requirePluginService(root))
	} finally {
		await root.effects.dispose()
	}
})

describe('Core immediate execution policy', () => {
	it('rejects competing execution authorities and forged bindings', () => {
		expect(() =>
			createCoreContextHost({
				execution: {},
				executionBinding: createCorePluginExecutionBinding(),
			}),
		).toThrow('cannot be supplied together')
		expect(() => createCoreContextHost({ executionBinding: {} as never })).toThrow(
			'Invalid Plugin execution binding',
		)
	})

	it.each([0, 1.5, 2_147_483_648, Number.NaN, Infinity])(
		'rejects invalid explicit deadlines without preparing a facility: %s',
		(startTimeoutMs) => {
			let preparations = 0
			expect(() =>
				createCoreContextHost({
					execution: { startTimeoutMs },
					logtape: () => {
						preparations++
						return { sinks: {}, loggers: [] }
					},
				}),
			).toThrow('execution.startTimeoutMs must be an integer from 1 to 2147483647')
			expect(() => Plugin({ startTimeoutMs })).toThrow('@Plugin startTimeoutMs must be an integer')
			expect(preparations).toBe(0)
		},
	)

	it('uses the Core default when no deadline is declared', async () => {
		const started = Promise.withResolvers<AbortSignal>()
		onDefaultPluginInit = started.resolve
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
		onTestFinished(() => {
			onDefaultPluginInit = undefined
			vi.useRealTimers()
		})
		await using host = createCoreInternalTestHost()
		host.add(DefaultTimeoutPlugin)
		const commit = host.commitAllowFail()
		const signal = await started.promise
		await vi.advanceTimersByTimeAsync(1_499)
		expect(signal.aborted).toBe(false)
		await vi.advanceTimersByTimeAsync(1)
		assertPluginLifecycleIssue(await commit, DefaultTimeoutPlugin, {
			phase: 'start',
			kind: 'start-failed',
			message: 'start timeout after 1500ms',
		})
		expect(signal.aborted).toBe(true)
	})
})

it('pins node, definition and Host deadlines for each starting generation', async () => {
	function rootWithDeadlines(
		startTimeoutMs: number,
		defaultNodeMs: number,
	): NonNullable<CoreInternalTestHostOptions['createRootContext']> {
		const nodeTimeouts = new Map([
			[pluginNodeIndexKey(TimedPlugin.nodeAddress()), defaultNodeMs],
			[pluginNodeIndexKey(TimedPlugin.nodeAddress('east')), 20],
		])
		const executionBinding = createCorePluginExecutionBinding(nodeTimeouts)
		nodeTimeouts.clear()
		executionBinding.bind({ startTimeoutMs })
		return (config) => createCoreContextHost({ ...config, executionBinding }).createRoot()
	}

	await using first = createCoreInternalTestHost(
		{},
		{ createRootContext: rootWithDeadlines(10, 15) },
	)
	await using second = createCoreInternalTestHost(
		{},
		{ createRootContext: rootWithDeadlines(30, 35) },
	)
	for (const [host, defaultMs, hostMs] of [
		[first, 15, 10],
		[second, 35, 30],
	] as const) {
		host.add([TimedPlugin, DefaultTimeoutPlugin])
		const east = host.fork(TimedPlugin, 'east')
		const west = host.fork(TimedPlugin, 'west')
		const summary = await host.commitAllowFail()
		for (const [node, timeout] of [
			[TimedPlugin, defaultMs],
			[east, 20],
			[west, 25],
			[DefaultTimeoutPlugin, hostMs],
		] as const) {
			assertPluginLifecycleIssue(summary, node, {
				phase: 'start',
				kind: 'start-failed',
				message: `start timeout after ${timeout}ms`,
			})
			expect(host.isRunning(node)).toBe(false)
		}
	}
})
