import { type PluginConstructor, BasePlugin, Plugin } from '@pluxel/core'
import { standardServices } from '@pluxel/services'
import { createTestHost, type TestHost, type RawPluginConfig } from '@pluxel/test'
import { CanvasPlugin } from '@pluxel/canvas'
import { FontsPlugin } from '@pluxel/fonts'
import { describe, expect, it } from 'vitest'
import { EChartsPlugin, type EChartsThemeRegistration } from '../src/index.ts'
import { EChartsWorkbench } from '../src/workbench.ts'
import { persistence } from '@pluxel/services/persistence'
import { nodeModules } from '@pluxel/services/node'
import { workers } from '@pluxel/services/workers'
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
		if (options.config !== undefined) change.config.seed(EChartsPlugin, options.config)
		change.start(plugins)
	})
}

describe('EChartsPlugin', () => {
	it('demonstrates worker admission pressure as a Result while cancellation still rejects', async () => {
		await using host = await createTestHost({
			services: [
				persistence({ mode: 'memory' }),
				nodeModules(),
				workers({ maxThreads: 1, maxQueuedTasks: 1, maxQueuedTasksPerPlugin: 1 }),
			],
		})
		await startEChartsFixture(host)
		const charts = host.require(EChartsTestConsumer).echarts
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
		await host.stop(EChartsTestConsumer)
		await expect(renderChart(charts, input)).rejects.toThrow(Error)
	})

	it('starts through the public Runtime host without requesting a worker artifact', async () => {
		await using host = await createTestHost({
			services: standardServices({ persistence: { mode: 'memory' } }),
		})

		await startEChartsFixture(host)
		expect(host.require(EChartsTestConsumer).echarts.defaultFont.family.length).toBeGreaterThan(0)
	})

	it('rejects invalid theme values before they become caller-owned state', async () => {
		await using host = await createTestHost({
			services: standardServices({ persistence: { mode: 'memory' } }),
		})

		await startEChartsFixture(host, { config: { maxThemeNodes: 2 } })
		const echarts = host.require(EChartsTestConsumer).echarts
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
		await using host = await createTestHost({
			services: standardServices({ persistence: { mode: 'memory' } }),
		})

		await startEChartsFixture(host, {
			config: { maxTotalThemes: 1 },
			otherConsumer: true,
		})
		const first = host.require(EChartsTestConsumer).echarts
		const second = host.require(EChartsOtherConsumer).echarts
		const registration = first.registerTheme({ name: 'first', theme: {} })

		expect(() => second.registerTheme({ name: 'second', theme: {} })).toThrow(
			expect.objectContaining({ code: 'THEME_LIMIT_EXCEEDED' }),
		)
		registration.dispose()
		const replacement = second.registerTheme({ name: 'second', theme: {} })
		expect(replacement.active).toBe(true)
	})

	it('bounds aggregate retained theme bytes and reconciles caller cleanup', async () => {
		await using host = await createTestHost({
			services: standardServices({ persistence: { mode: 'memory' } }),
		})

		await startEChartsFixture(host, {
			config: { maxTotalThemes: 2, maxTotalThemeBytes: 20 },
			otherConsumer: true,
		})
		const first = host.require(EChartsTestConsumer).echarts
		const second = host.require(EChartsOtherConsumer).echarts
		const registration = first.registerTheme({
			name: 'first',
			theme: { a: '1234567890' },
		})

		expect(() => second.registerTheme({ name: 'second', theme: { a: '1234567890' } })).toThrow(
			expect.objectContaining({ code: 'THEME_LIMIT_EXCEEDED' }),
		)
		await host.stop(EChartsTestConsumer)
		expect(registration.active).toBe(false)
		const replacement = second.registerTheme({
			name: 'second',
			theme: { a: '1234567890' },
		})
		expect(replacement.active).toBe(true)
	})

	it('keeps named themes caller-owned and revokes them with the caller generation', async () => {
		await using host = await createTestHost({
			services: standardServices({ persistence: { mode: 'memory' } }),
		})

		await startEChartsFixture(host, { otherConsumer: true })
		const capability = host.require(EChartsTestConsumer).echarts
		const other = host.require(EChartsOtherConsumer).echarts
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
		await host.stop(EChartsTestConsumer)

		expect(ephemeral.active).toBe(false)
		expect(() => capability.themes).toThrow('Plugin owner stopped')
		expect(otherRegistration.active).toBe(true)
	})

	it('places the provider-owned Fonts selection Attachment', async () => {
		await using host = await createTestHost({
			workbench: true,
			services: standardServices({ persistence: { mode: 'memory' } }),
		})

		await host.start([FontsPlugin, CanvasPlugin, EChartsPlugin])

		using selection = await host.workbench.open({
			target: EChartsPlugin,
			entry: EChartsWorkbench.fonts,
			principal: { provider: 'test', subject: 'echarts-tests' },
		})
		expect(selection).toMatchObject({
			kind: 'attachment',
			params: {},
			federatedViewRef: { expose: './views/selection' },
		})
		expect(await selection.provider.snapshotDto()).toMatchObject({
			defaultFont: host.require(EChartsPlugin).defaultFont,
			families: expect.any(Array),
		})
	})
})
