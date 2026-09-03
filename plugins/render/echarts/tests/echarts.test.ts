import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { CanvasPlugin } from '@pluxel/canvas'
import { FontsPlugin } from '@pluxel/fonts'
import type { PluginConstructor } from '@pluxel/runtime'
import {
	createRuntimeInternalTestHost,
	type RuntimeInternalTestHost,
} from '@pluxel/runtime/internal/test'
import { BasePlugin, Plugin, type RawPluginConfig } from '@pluxel/runtime/test'
import { buildNodeModule } from '@pluxel/rolldown/vite/node-module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EChartsPlugin, type EChartsOption, type EChartsThemeRegistration } from '../src/index.ts'
import { EChartsWorkbench } from '../src/workbench.ts'

@Plugin()
class EChartsTestConsumer extends BasePlugin {
	constructor(
		readonly echarts: EChartsPlugin,
		readonly canvas: CanvasPlugin,
		readonly fonts: FontsPlugin,
	) {
		super()
	}
}

@Plugin()
class EChartsOtherConsumer extends BasePlugin {
	constructor(readonly echarts: EChartsPlugin) {
		super()
	}
}

const barOption: EChartsOption = {
	title: { text: 'Pluxel' },
	xAxis: { type: 'category', data: ['A', 'B', 'C'] },
	yAxis: { type: 'value' },
	series: [{ type: 'bar', data: [3, 7, 5] }],
}

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const fontPath = findTestFont()
let workerBuildDir: string
let workerUrl: URL

beforeAll(async () => {
	workerBuildDir = await mkdtemp(join(tmpdir(), 'pluxel-echarts-worker-test-'))
	const outFile = join(workerBuildDir, 'worker.mjs')
	await buildNodeModule({
		root: packageRoot,
		entryPath: join(packageRoot, 'src/worker.ts'),
		outFile,
		minify: false,
	})
	workerUrl = pathToFileURL(outFile)
}, 30_000)

afterAll(async () => {
	await rm(workerBuildDir, { recursive: true, force: true })
})

async function startEChartsFixture(
	host: RuntimeInternalTestHost,
	options: Readonly<{ config?: RawPluginConfig; otherConsumer?: boolean }> = {},
): Promise<void> {
	const detach = host.ctx.nodeModules.attachSourceBinder(async () => ({
		url: workerUrl,
		dispose: () => undefined,
	}))
	host.ctx.effects.defer(detach)
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

async function verifyManagedWorkerFont(consumer: EChartsTestConsumer, path: string): Promise<void> {
	const family = `ECharts Worker ${randomUUID()}`
	await consumer.fonts.registerFromPath({ path, family })
	await consumer.fonts.setPreferredFamily(family)
	expect(consumer.echarts.defaultFont.family).toBe(family)
	await expect(
		consumer.echarts.render({ width: 240, height: 120, option: barOption }),
	).resolves.toMatchObject({ mediaType: 'image/png' })
}

describe('EChartsPlugin', () => {
	it('renders through the built worker while enforcing render boundaries', async () => {
		{
			await using host = createRuntimeInternalTestHost({ workbench: false })

			await startEChartsFixture(host)
			const consumer = host.require(EChartsTestConsumer)
			expect(consumer.echarts.defaultFont.family.length).toBeGreaterThan(0)

			const source = consumer.canvas.createCanvasSync(4, 4)
			source.getContext('2d').fillRect(0, 0, 4, 4)
			const sourceBytes = await source.encode('png')
			const dataUrl = `data:image/png;base64,${sourceBytes.toString('base64')}`
			const svgDataUrl = `data:image/svg+xml,${encodeURIComponent(
				'<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="#2563eb"/></svg>',
			)}`
			const imageOption = (image: string): EChartsOption => ({
				graphic: {
					elements: [{ type: 'image', left: 0, top: 0, style: { image, width: 4, height: 4 } }],
				},
			})
			const rasterOption = imageOption(dataUrl)
			const vectorOption = imageOption(svgDataUrl)
			const concurrent = await Promise.all([
				consumer.echarts.render({ width: 32, height: 32, option: rasterOption }),
				consumer.echarts.render({ width: 48, height: 24, option: vectorOption }),
			])

			expect(concurrent.map(({ mediaType }) => mediaType)).toEqual(['image/png', 'image/png'])
			expect(concurrent[0]?.width).toBe(32)
			expect([...concurrent[0]!.data.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
			expect(rasterOption).toMatchObject({
				graphic: { elements: [{ style: { image: dataUrl } }] },
			})
			expect(vectorOption).toMatchObject({
				graphic: { elements: [{ style: { image: svgDataUrl } }] },
			})
			await expect(
				consumer.echarts.render({
					width: 32,
					height: 32,
					option: imageOption('https://example.invalid/private.png'),
				}),
			).rejects.toMatchObject({ code: 'UNSUPPORTED_IMAGE_SOURCE' })

			const formatterOption: EChartsOption = {
				...barOption,
				tooltip: { formatter: () => 'inline' },
			}
			await expect(
				consumer.echarts.render({ width: 240, height: 120, option: formatterOption }),
			).rejects.toMatchObject({ code: 'WORKER_INPUT_UNSUPPORTED' })

			if (fontPath) await verifyManagedWorkerFont(consumer, fontPath)
		}
	})

	it('rejects oversized or imperative options before worker admission', async () => {
		{
			await using host = createRuntimeInternalTestHost({ workbench: false })

			await startEChartsFixture(host, {
				config: { maxOptionNodes: 8, maxThemeNodes: 2 },
			})
			const echarts = host.require(EChartsTestConsumer).echarts
			await expect(
				echarts.render({
					width: 32,
					height: 32,
					option: { series: [{ type: 'line', data: [1, 2, 3, 4, 5, 6, 7, 8] }] },
				}),
			).rejects.toMatchObject({ code: 'OPTION_TOO_LARGE' })

			let getterCalled = false
			const option = Object.defineProperty({}, 'series', {
				enumerable: true,
				get() {
					getterCalled = true
					return []
				},
			}) as EChartsOption
			await expect(echarts.render({ width: 32, height: 32, option })).rejects.toMatchObject({
				code: 'WORKER_INPUT_UNSUPPORTED',
			})
			expect(getterCalled).toBe(false)
			await expect(
				echarts.render({
					width: 32,
					height: 32,
					option: {},
					setOption: { transition: ((): void => undefined) as never },
				}),
			).rejects.toMatchObject({ code: 'WORKER_INPUT_UNSUPPORTED' })

			expect(() =>
				echarts.registerTheme({ name: 'too-many-values', theme: { color: ['red'] } }),
			).toThrow(expect.objectContaining({ code: 'THEME_TOO_LARGE' }))
			let themeGetterCalled = false
			const theme = Object.defineProperty({}, 'color', {
				enumerable: true,
				get() {
					themeGetterCalled = true
					return ['red']
				},
			})
			expect(() => echarts.registerTheme({ name: 'accessor', theme })).toThrow(
				expect.objectContaining({ code: 'INVALID_THEME' }),
			)
			expect(themeGetterCalled).toBe(false)
		}
	})

	it('rejects a full worker queue before walking the option graph', async () => {
		{
			await using host = createRuntimeInternalTestHost({
				workbench: false,
				workers: { maxThreads: 1, maxQueuedTasks: 1, maxQueuedTasksPerPlugin: 1 },
			})

			await startEChartsFixture(host)
			const echarts = host.require(EChartsTestConsumer).echarts
			await echarts.render({ width: 16, height: 16, option: {} })
			const running = echarts.render({ width: 640, height: 360, option: barOption })
			const queued = echarts.render({ width: 320, height: 180, option: barOption })
			let getterCalled = false
			const rejectedOption = Object.defineProperty({}, 'series', {
				enumerable: true,
				get() {
					getterCalled = true
					return []
				},
			}) as EChartsOption

			await expect(
				echarts.render({ width: 16, height: 16, option: rejectedOption }),
			).rejects.toMatchObject({ code: 'RENDER_BUSY' })
			expect(getterCalled).toBe(false)
			await Promise.all([running, queued])
		}
	})

	it('cancels cooperative measurement of a large option string', async () => {
		{
			await using host = createRuntimeInternalTestHost({ workbench: false })

			await startEChartsFixture(host, { config: { maxOptionBytes: 4 * 1024 * 1024 } })
			const controller = new AbortController()
			const reason = new DOMException('cancel option measurement', 'AbortError')
			const rendering = host.require(EChartsTestConsumer).echarts.render({
				width: 16,
				height: 16,
				option: { title: { text: '界'.repeat(1024 * 1024) } },
				signal: controller.signal,
			})
			setImmediate(() => controller.abort(reason))
			await expect(rendering).rejects.toBe(reason)
		}
	})

	it('does not reinterpret ordinary data URL text as an image source', async () => {
		{
			await using host = createRuntimeInternalTestHost({ workbench: false })

			await startEChartsFixture(host, { config: { maxDataUrlBytes: 4 } })

			await expect(
				host.require(EChartsTestConsumer).echarts.render({
					width: 240,
					height: 120,
					option: {
						...barOption,
						title: { text: 'data:text/plain,this-is-label-text' },
					},
				}),
			).resolves.toMatchObject({ mediaType: 'image/png' })
		}
	})

	it('bounds distinct image sources and aggregate decoded pixels per render', async () => {
		{
			await using host = createRuntimeInternalTestHost({ workbench: false })

			await startEChartsFixture(host, {
				config: { maxImages: 2, maxTotalImagePixels: 20 },
			})
			const echarts = host.require(EChartsTestConsumer).echarts
			const sources = ['#ef4444', '#22c55e', '#3b82f6'].map(
				(color) =>
					`data:image/svg+xml,${encodeURIComponent(
						`<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="${color}"/></svg>`,
					)}`,
			)
			const imageOption = (images: readonly string[]): EChartsOption => ({
				graphic: {
					elements: images.map((image, index) => ({
						type: 'image',
						left: index * 4,
						top: 0,
						style: { image, width: 4, height: 4 },
					})),
				},
			})

			await expect(
				echarts.render({ width: 16, height: 8, option: imageOption(sources) }),
			).rejects.toMatchObject({ code: 'IMAGE_SOURCE_TOO_LARGE' })
			await expect(
				echarts.render({ width: 16, height: 8, option: imageOption(sources.slice(0, 2)) }),
			).rejects.toMatchObject({ code: 'IMAGE_SOURCE_TOO_LARGE' })
		}
	})

	it('bounds aggregate decoded image source bytes before native decode', async () => {
		{
			await using host = createRuntimeInternalTestHost({ workbench: false })

			await startEChartsFixture(host, {
				config: { maxImages: 2, maxTotalImageBytes: 1 },
			})
			const images = [
				'data:application/octet-stream;base64,AA==',
				'data:application/octet-stream;base64,AQ==',
			]
			await expect(
				host.require(EChartsTestConsumer).echarts.render({
					width: 16,
					height: 8,
					option: {
						graphic: {
							elements: images.map((image, index) => ({
								type: 'image',
								left: index,
								top: 0,
								style: { image, width: 1, height: 1 },
							})),
						},
					},
				}),
			).rejects.toMatchObject({ code: 'IMAGE_SOURCE_TOO_LARGE' })
		}
	})

	it('rejects encoded output before it crosses the worker boundary', async () => {
		{
			await using host = createRuntimeInternalTestHost({ workbench: false })

			await startEChartsFixture(host, { config: { maxOutputBytes: 8 } })

			await expect(
				host
					.require(EChartsTestConsumer)
					.echarts.render({ width: 32, height: 32, option: barOption }),
			).rejects.toMatchObject({ code: 'OUTPUT_TOO_LARGE' })
		}
	})

	it('bounds provider-wide retained theme count and returns capacity on dispose', async () => {
		{
			await using host = createRuntimeInternalTestHost({ workbench: false })

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
		}
	})

	it('bounds aggregate retained theme bytes and reconciles caller cleanup', async () => {
		{
			await using host = createRuntimeInternalTestHost({ workbench: false })

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
		}
	})

	it('keeps named themes caller-owned and revokes them with the caller generation', async () => {
		{
			await using host = createRuntimeInternalTestHost({ workbench: false })

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
			await expect(
				capability.render({ width: 240, height: 120, option: barOption, theme: 'reporting' }),
			).resolves.toMatchObject({ mediaType: 'image/png' })
			await expect(
				other.render({ width: 240, height: 120, option: barOption, theme: 'reporting' }),
			).resolves.toMatchObject({ mediaType: 'image/png' })

			registration.dispose()
			expect(registration.active).toBe(false)
			await expect(
				capability.render({ width: 240, height: 120, option: barOption, theme: 'reporting' }),
			).rejects.toMatchObject({ code: 'THEME_NOT_FOUND' })
			expect(otherRegistration.active).toBe(true)

			const ephemeral: EChartsThemeRegistration = capability.registerTheme({
				name: 'ephemeral',
				theme: { color: ['#16a34a'] },
			})
			await host.stop(EChartsTestConsumer)

			expect(ephemeral.active).toBe(false)
			expect(() => capability.themes).toThrow('Plugin owner stopped')
			expect(otherRegistration.active).toBe(true)
		}
	})

	it('places the provider-owned Fonts selection Attachment', async () => {
		{
			await using host = createRuntimeInternalTestHost({ workbench: { enabled: true } })

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
			expect(await selection.provider.snapshot()).toMatchObject({
				defaultFont: host.require(EChartsPlugin).defaultFont,
				families: expect.any(Array),
			})
		}
	})
})

function findTestFont(): string | undefined {
	return [
		'/usr/share/fonts/dejavu/DejaVuSans.ttf',
		'/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
		'/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf',
	].find((path) => existsSync(path))
}
