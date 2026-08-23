import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { CanvasPlugin } from '@pluxel/canvas'
import { FontsPlugin } from '@pluxel/fonts'
import type { PluginConstructor } from '@pluxel/runtime'
import {
	BasePlugin,
	Plugin,
	pluginNodeAddressOf,
	type RuntimeHost,
	withRuntimeHost,
} from '@pluxel/runtime/test'
import { requireWorkbench } from '@pluxel/runtime/internal'
import { buildNodeModule } from '@pluxel/rolldown/vite/node-module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
	EChartsError,
	EChartsPlugin,
	type EChartsOption,
	type EChartsThemeRegistration,
} from '../src/index.ts'

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
	workerBuildDir = await mkdtemp(join(packageRoot, '.pluxel-echarts-worker-test-'))
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

function addEnabled(host: RuntimeHost, plugins: readonly PluginConstructor[]): void {
	host.add(plugins)
	for (const PluginClass of plugins) host.cfg(PluginClass).enable()
}

function addEChartsHost(host: RuntimeHost): void {
	const detach = host.ctx.nodeModules.attachSourceBinder(async () => ({
		url: workerUrl,
		dispose: () => undefined,
	}))
	host.ctx.effects.defer(detach)
	addEnabled(host, [FontsPlugin, CanvasPlugin, EChartsPlugin, EChartsTestConsumer])
}

async function verifyManagedWorkerFont(consumer: EChartsTestConsumer, path: string): Promise<void> {
	const family = `ECharts Worker ${randomUUID()}`
	consumer.fonts.registerFromPath({ path, family })
	await consumer.fonts.selectionManager().setDefaultFamily(family)
	expect(consumer.echarts.defaultFont.family).toBe(family)
	await expect(
		consumer.echarts.render({ width: 240, height: 120, option: barOption }),
	).resolves.toMatchObject({ mediaType: 'image/png' })
}

describe('EChartsPlugin', () => {
	it('renders through the built worker while enforcing render boundaries', async () => {
		await withRuntimeHost(
			async (host) => {
				addEChartsHost(host)
				await host.commit()
				const consumer = host.require(EChartsTestConsumer)
				expect(consumer.echarts.defaultFont.family.length).toBeGreaterThan(0)
				expect('workbench' in host.ctx).toBe(false)
				expect(host.ctx.workbench).toBeUndefined()

				const source = consumer.canvas.createCanvas(4, 4)
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
				await expect(
					consumer.echarts.render({
						width: 240,
						height: 120,
						option: formatterOption,
						execution: 'inline',
					}),
				).resolves.toMatchObject({ mediaType: 'image/png' })

				if (fontPath) await verifyManagedWorkerFont(consumer, fontPath)
			},
			{ workbench: false },
		)
	})

	it('does not reinterpret ordinary data URL text as an image source', async () => {
		await withRuntimeHost(
			async (host) => {
				addEChartsHost(host)
				host.cfg(EChartsPlugin).set({ maxDataUrlBytes: 4 })
				await host.commit()

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
			},
			{ workbench: false },
		)
	})

	it('keeps named themes caller-owned and revokes them with the caller generation', async () => {
		await withRuntimeHost(
			async (host) => {
				addEChartsHost(host)
				addEnabled(host, [EChartsOtherConsumer])
				await host.commit()
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
				host.cfg(EChartsTestConsumer).disable()
				await host.commit()

				expect(ephemeral.active).toBe(false)
				expect(() => capability.themes).toThrow(
					expect.objectContaining<Partial<EChartsError>>({ code: 'NOT_RUNNING' }),
				)
				expect(otherRegistration.active).toBe(true)
			},
			{ workbench: false },
		)
	})

	it('mounts the Fonts provider Port in the ECharts target workbench', async () => {
		await withRuntimeHost(
			async (host) => {
				addEnabled(host, [FontsPlugin, CanvasPlugin, EChartsPlugin])
				await host.commit()

				const layout = requireWorkbench(host.ctx).registry.getPluginLayout(
					pluginNodeAddressOf(EChartsPlugin),
				)
				expect(layout.items).toEqual([
					expect.objectContaining({
						owner: {
							address: pluginNodeAddressOf(FontsPlugin),
							displayName: 'FontsPlugin',
							rootExportName: 'FontsPlugin',
						},
						target: {
							address: pluginNodeAddressOf(EChartsPlugin),
							displayName: 'EChartsPlugin',
							rootExportName: 'EChartsPlugin',
						},
						viewId: 'FontSelection',
						port: expect.objectContaining({ id: '@pluxel/fonts.selection' }),
					}),
				])
			},
			{ workbench: { enabled: true } },
		)
	})
})

function findTestFont(): string | undefined {
	return [
		'/usr/share/fonts/dejavu/DejaVuSans.ttf',
		'/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
		'/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf',
	].find((path) => existsSync(path))
}
