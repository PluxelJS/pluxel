import { type PluginConstructor, BasePlugin, Plugin } from '@pluxel/core'
import { elysia } from '@pluxel/services/elysia'
import { nodeModules } from '@pluxel/services/node'
import { workers } from '@pluxel/services/workers'
import { createTestHost, type TestHost, type RawPluginConfig } from '@pluxel/test'
import { CanvasPlugin } from '@pluxel/plugin-canvas'
import { FontsPlugin } from '@pluxel/plugin-fonts'
import { describe, expect, it } from 'vitest'
import { EChartsPlugin, type EChartsThemeRegistration } from '../src/index.ts'
import { EChartsWorkbench } from '../src/workbench.ts'
import { renderChart } from './fixtures/result-consumer.ts'

@Plugin()
class EChartsTestConsumer extends BasePlugin {
	constructor(readonly echarts: EChartsPlugin) {
		super()
	}
}

@Plugin()
class EChartsOtherConsumer extends BasePlugin {
	constructor(readonly echarts: EChartsPlugin) {
		super()
	}
}

async function startEChartsFixture(
	host: TestHost<boolean>,
	options: Readonly<{ config?: RawPluginConfig; otherConsumer?: boolean }> = {},
): Promise<void> {
	const plugins: readonly PluginConstructor[] = [
		FontsPlugin,
		CanvasPlugin,
		EChartsPlugin,
		EChartsTestConsumer,
		...(options.otherConsumer ? [EChartsOtherConsumer] : []),
	]
	await host.commit((change) => {
		change.catalog.add(plugins)
		if (options.config !== undefined)
			change.config.seed(EChartsPlugin.nodeAddress(), options.config)
		change.start(plugins.map((plugin) => plugin.nodeAddress()))
	})
}

describe('EChartsPlugin', () => {
	// This compiles and starts a real native worker; cold startup is not a 5-second SLA.
	it('demonstrates worker admission pressure as a Result while cancellation still rejects', async () => {
		await using host = await createTestHost({
			services: [
				nodeModules(),
				workers({ maxThreads: 1, maxQueuedTasks: 1, maxQueuedTasksPerPlugin: 1 }),
			],
		})
		await startEChartsFixture(host)
		const charts = host.require(EChartsTestConsumer.nodeAddress()).echarts
		const input = { option: {}, width: 32, height: 32 }
		const [first, second, third] = await Promise.all([
			renderChart(charts, input),
			renderChart(charts, input),
			renderChart(charts, input),
		])
		expect(first.isOk()).toBe(true)
		expect(second.isOk()).toBe(true)
		expect(third.isErr()).toBe(true)
		if (third.isOk()) throw new Error('Unexpected Result branch')
		expect(third.error._tag).toBe('ChartBusy')
		const aborted = new Error('caller cancelled')
		await expect(
			renderChart(charts, { ...input, signal: AbortSignal.abort(aborted) }),
		).rejects.toBe(aborted)
		await host.stop(EChartsTestConsumer.nodeAddress())
		await expect(renderChart(charts, input)).rejects.toThrow(Error)
	}, 30_000)

	it('rejects invalid theme values before they become caller-owned state', async () => {
		await using host = await createTestHost()

		await startEChartsFixture(host, { config: { maxThemeNodes: 2 } })
		const echarts = host.require(EChartsTestConsumer.nodeAddress()).echarts
		expect(() =>
			echarts.registerTheme({ name: 'too-many-values', theme: { color: ['red'] } }),
		).toThrow(expect.objectContaining({ code: 'THEME_TOO_LARGE' }))
		let getterCalled = false
		const theme = Object.defineProperty({}, 'color', {
			enumerable: true,
			get() {
				getterCalled = true
				return ['red']
			},
		})
		expect(() => echarts.registerTheme({ name: 'accessor', theme })).toThrow(
			expect.objectContaining({ code: 'INVALID_THEME' }),
		)
		expect(getterCalled).toBe(false)
	})

	it('bounds provider-wide retained theme count and returns capacity on dispose', async () => {
		await using host = await createTestHost()

		await startEChartsFixture(host, {
			config: { maxTotalThemes: 1 },
			otherConsumer: true,
		})
		const first = host.require(EChartsTestConsumer.nodeAddress()).echarts
		const second = host.require(EChartsOtherConsumer.nodeAddress()).echarts
		const registration = first.registerTheme({ name: 'first', theme: {} })

		expect(() => second.registerTheme({ name: 'second', theme: {} })).toThrow(
			expect.objectContaining({ code: 'THEME_LIMIT_EXCEEDED' }),
		)
		registration.dispose()
		const replacement = second.registerTheme({ name: 'second', theme: {} })
		expect(replacement.active).toBe(true)
	})

	it('bounds aggregate retained theme bytes and reconciles caller cleanup', async () => {
		await using host = await createTestHost()

		await startEChartsFixture(host, {
			config: { maxTotalThemes: 2, maxTotalThemeBytes: 20 },
			otherConsumer: true,
		})
		const first = host.require(EChartsTestConsumer.nodeAddress()).echarts
		const second = host.require(EChartsOtherConsumer.nodeAddress()).echarts
		const registration = first.registerTheme({
			name: 'first',
			theme: { a: '1234567890' },
		})

		expect(() => second.registerTheme({ name: 'second', theme: { a: '1234567890' } })).toThrow(
			expect.objectContaining({ code: 'THEME_LIMIT_EXCEEDED' }),
		)
		await host.stop(EChartsTestConsumer.nodeAddress())
		expect(registration.active).toBe(false)
		const replacement = second.registerTheme({
			name: 'second',
			theme: { a: '1234567890' },
		})
		expect(replacement.active).toBe(true)
	})

	it('keeps named themes caller-owned and revokes them with the caller generation', async () => {
		await using host = await createTestHost()

		await startEChartsFixture(host, { otherConsumer: true })
		const capability = host.require(EChartsTestConsumer.nodeAddress()).echarts
		const other = host.require(EChartsOtherConsumer.nodeAddress()).echarts
		const registration = capability.registerTheme({
			name: 'reporting',
			theme: { color: ['#2563eb'], textStyle: { fontWeight: 500 } },
		})
		const otherRegistration = other.registerTheme({
			name: 'reporting',
			theme: { color: ['#dc2626'] },
		})

		expect(capability.themes).toEqual([
			expect.objectContaining({ name: 'reporting', byteLength: expect.any(Number) }),
		])
		registration.dispose()
		expect(registration.active).toBe(false)
		expect(capability.themes).toEqual([])
		expect(otherRegistration.active).toBe(true)

		const ephemeral: EChartsThemeRegistration = capability.registerTheme({
			name: 'ephemeral',
			theme: { color: ['#16a34a'] },
		})
		await host.stop(EChartsTestConsumer.nodeAddress())

		expect(ephemeral.active).toBe(false)
		expect(() => capability.themes).toThrow('Plugin owner stopped')
		expect(otherRegistration.active).toBe(true)
	})

	it('places the provider-owned Fonts selection Attachment', async () => {
		await using host = await createTestHost({
			workbench: true,
			services: [elysia()],
		})

		await host.start([
			FontsPlugin.nodeAddress(),
			CanvasPlugin.nodeAddress(),
			EChartsPlugin.nodeAddress(),
		])

		using selection = await host.workbench.open({
			target: EChartsPlugin.nodeAddress(),
			entry: EChartsWorkbench.fonts,
			principal: { provider: 'test', subject: 'echarts-tests' },
		})
		expect(selection).toMatchObject({
			kind: 'attachment',
			params: {},
			federatedViewRef: { expose: './views/selection' },
		})
		expect(await selection.provider.snapshotDto()).toMatchObject({
			defaultFont: host.require(EChartsPlugin.nodeAddress()).defaultFont,
			families: expect.any(Array),
		})
	})
})
