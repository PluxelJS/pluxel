import { v, type PluginConstructor } from '@pluxel/runtime'
import {
	BasePlugin,
	createRuntimeTestHost,
	Plugin,
	type RawPluginConfig,
	type RuntimeTestHost,
} from '@pluxel/runtime/test'
import { describe, expect, it } from 'vitest'
import { GlobalFonts } from '@napi-rs/canvas'
import { FontsPlugin } from '@pluxel/fonts'
import {
	CanvasConfig,
	CanvasError,
	CanvasPlugin,
	layoutWithLines,
	measureRichInlineStats,
} from '../src/index.ts'
import { createCanvasWorkerAdapter } from '../src/worker.ts'
import { createCanvasWorkerTextLayout } from '../src/worker-pretext.ts'
import { CanvasWorkbench } from '../src/workbench.ts'

@Plugin()
class CanvasTestConsumer extends BasePlugin {
	constructor(readonly canvas: CanvasPlugin) {
		super()
	}
}

@Plugin()
class CanvasFontAdminConsumer extends BasePlugin {
	constructor(
		readonly canvas: CanvasPlugin,
		readonly fonts: FontsPlugin,
	) {
		super()
	}
}

async function startCanvasFixture(
	host: RuntimeTestHost,
	plugins: readonly PluginConstructor[],
	initialConfig?: RawPluginConfig,
): Promise<void> {
	await host.commit((change) => {
		change.catalog.add(plugins)
		if (initialConfig !== undefined) change.config.seed(CanvasPlugin, initialConfig)
		change.start(plugins)
	})
}

const discoveredFamily = GlobalFonts.families[0]?.family

describe('CanvasPlugin', () => {
	it('keeps root and per-worker native decode defaults separate', () => {
		expect(v.parse(CanvasConfig, {})).toMatchObject({
			maxConcurrentDecodes: 2,
			maxQueuedDecodes: 32,
			maxQueuedDecodesPerConsumer: 8,
			maxConcurrentDecodesPerWorkerAdapter: 1,
			maxQueuedDecodesPerWorkerAdapter: 32,
		})
	})

	it('creates native raster and SVG canvases in a headless host', async () => {
		{
			await using host = createRuntimeTestHost({ workbench: false })

			await startCanvasFixture(host, [FontsPlugin, CanvasPlugin, CanvasTestConsumer])
			const canvas = host.require(CanvasTestConsumer).canvas.createCanvasSync(64, 32)
			const context = canvas.getContext('2d')
			context.fillStyle = '#ff0000'
			context.fillRect(0, 0, canvas.width, canvas.height)
			const png = await canvas.encode('png')
			const svg = host.require(CanvasTestConsumer).canvas.createSvgCanvasSync(40, 20, {
				mode: 'compact',
			})
			svg.getContext('2d').fillRect(0, 0, 40, 20)

			expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
			expect(svg.getContent().toString()).toContain('<svg')
		}
	})

	it('creates a bounded native worker adapter from a detached host snapshot', async () => {
		{
			await using host = createRuntimeTestHost({ workbench: false })

			await startCanvasFixture(host, [FontsPlugin, CanvasPlugin, CanvasTestConsumer])
			const capability = host.require(CanvasTestConsumer).canvas
			const snapshot = capability.workerSnapshot
			expect(snapshot.decodeLimits).toEqual({ maxConcurrent: 1, maxQueued: 32 })
			const workerCanvas = createCanvasWorkerAdapter(structuredClone(snapshot))
			const canvas = workerCanvas.createCanvas(24, 12)
			canvas.getContext('2d').fillRect(0, 0, 24, 12)
			const encoded = await canvas.encode('png')
			const target = workerCanvas.createImage()
			const image = await workerCanvas.decodeImageInto(target, encoded)
			const text = createCanvasWorkerTextLayout(structuredClone(snapshot))
			const prepared = text.prepareTextWithSegments({
				text: 'Worker 中的 Pretext 仍然使用统一字体快照',
				fontSize: 18,
			})

			expect({ width: image.width, height: image.height }).toEqual({ width: 24, height: 12 })
			expect(image).toBe(target)
			expect(layoutWithLines(prepared, 100, 24).lineCount).toBeGreaterThan(1)
			expect(() =>
				text.prepareText({
					text: 'x'.repeat(snapshot.textLimits.maxTextCharacters + 1),
				}),
			).toThrowError(expect.objectContaining({ code: 'TEXT_TOO_LARGE' }))
			expect(workerCanvas.snapshot.font.cssFamily).toBe(snapshot.font.cssFamily)
			expect(Object.isFrozen(workerCanvas.snapshot.limits)).toBe(true)
			expect(Object.isFrozen(workerCanvas.snapshot.decodeLimits)).toBe(true)
			expect(capability.workerSnapshot).toBe(snapshot)
			expect(() => workerCanvas.createCanvas(snapshot.limits.maxWidth + 1, 1)).toThrowError(
				expect.objectContaining({ code: 'DIMENSIONS_EXCEEDED' }),
			)

			const singleDecode = createCanvasWorkerAdapter({
				...structuredClone(snapshot),
				decodeLimits: { maxConcurrent: 1, maxQueued: 0 },
			})
			const activeDecode = singleDecode.decodeImage(encoded)
			await expect(singleDecode.decodeImage(encoded)).rejects.toMatchObject({
				code: 'DECODE_BUSY',
			})
			await expect(activeDecode).resolves.toMatchObject({ width: 24, height: 12 })
			await singleDecode.close()
			await singleDecode.close()
			await expect(singleDecode.decodeImage(encoded)).rejects.toMatchObject({
				code: 'NOT_RUNNING',
			})
			let finalDecodeSettled = false
			const finalDecode = workerCanvas.decodeImage(encoded)
			void finalDecode.finally((): void => {
				finalDecodeSettled = true
			})
			await workerCanvas.close()
			expect(finalDecodeSettled).toBe(true)
			await expect(finalDecode).resolves.toMatchObject({ width: 24, height: 12 })
			expect(() => workerCanvas.createCanvas(1, 1)).toThrowError(
				expect.objectContaining({ code: 'NOT_RUNNING' }),
			)
		}
	})

	it.skipIf(!discoveredFamily)(
		'applies provider preference changes to subsequently created raster and SVG contexts',
		async () => {
			{
				await using host = createRuntimeTestHost({ workbench: false })

				await startCanvasFixture(host, [FontsPlugin, CanvasPlugin, CanvasFontAdminConsumer])
				const consumer = host.require(CanvasFontAdminConsumer)
				const initialWorkerSnapshot = consumer.canvas.workerSnapshot

				await consumer.fonts.setPreferredFamily(discoveredFamily!)
				expect(consumer.canvas.createCanvasSync(2, 2).getContext('2d').font).toContain(
					discoveredFamily,
				)
				expect(consumer.canvas.workerSnapshot).not.toBe(initialWorkerSnapshot)
				expect(consumer.canvas.workerSnapshot.font.requiredFamily).toBe(discoveredFamily)

				await consumer.fonts.setPreferredFamily('monospace')
				expect(consumer.canvas.createSvgCanvasSync(2, 2).getContext('2d').font).toBe(
					'10px monospace',
				)
				expect(consumer.canvas.workerSnapshot.font.requiredFamily).toBeUndefined()
				const workerCanvas = createCanvasWorkerAdapter(consumer.canvas.workerSnapshot)
				try {
					expect(() => workerCanvas.createCanvas(2, 2)).not.toThrow()
				} finally {
					await workerCanvas.close()
				}
			}
		},
	)

	it('decodes caller-provided bytes without adding an outbound HTTP policy', async () => {
		{
			await using host = createRuntimeTestHost({ workbench: false })

			await startCanvasFixture(host, [FontsPlugin, CanvasPlugin, CanvasTestConsumer])
			const capability = host.require(CanvasTestConsumer).canvas
			const source = capability.createCanvasSync(11, 7)
			const borrowedBytes = await source.encode('png')
			const image = await capability.decodeImage(borrowedBytes)
			borrowedBytes.fill(0)
			expect({ width: image.width, height: image.height }).toEqual({ width: 11, height: 7 })

			const ownedBytes = await source.encode('png')
			const ownedImage = await capability.decodeImage(ownedBytes, {
				dataOwnership: 'owned',
			})
			expect({ width: ownedImage.width, height: ownedImage.height }).toEqual({
				width: 11,
				height: 7,
			})
			await expect(
				capability.decodeImage(await source.encode('png'), {
					dataOwnership: 'shared' as 'owned',
				}),
			).rejects.toMatchObject({ code: 'INVALID_IMAGE' })
		}
	})

	it('cooperatively snapshots borrowed decode bytes and observes cancellation', async () => {
		{
			await using host = createRuntimeTestHost({ workbench: false })

			await startCanvasFixture(host, [FontsPlugin, CanvasPlugin, CanvasTestConsumer])
			const controller = new AbortController()
			const decoded = host
				.require(CanvasTestConsumer)
				.canvas.decodeImage(new Uint8Array(2 * 1024 * 1024), { signal: controller.signal })
			queueMicrotask(() => controller.abort())
			await expect(decoded).rejects.toMatchObject({ name: 'AbortError' })
		}
	})

	it('uses bounded Pretext for multiline and rich-inline layout', async () => {
		{
			await using host = createRuntimeTestHost({ workbench: false })

			await startCanvasFixture(host, [FontsPlugin, CanvasPlugin, CanvasTestConsumer])
			const capability = host.require(CanvasTestConsumer).canvas
			const prepared = capability.prepareTextWithSegmentsSync({
				text: 'Pluxel 可以正确处理多语言 canvas text layout',
				fontSize: 18,
			})
			const result = layoutWithLines(prepared, 120, 24)

			expect(result.lineCount).toBeGreaterThan(1)
			expect(result.height).toBe(result.lineCount * 24)
			expect(result.lines.map(({ text }) => text).join('')).toContain('Pluxel')
			const rich = capability.prepareRichInlineSync([
				{ text: 'Ship ', fontSize: 16 },
				{ text: '@pluxel', font: '700 14px sans-serif', break: 'never', extraWidth: 12 },
			])
			expect(measureRichInlineStats(rich, 200)).toMatchObject({ lineCount: 1 })
		}
	})

	it('rejects text before Pretext work when the host character budget is exceeded', async () => {
		{
			await using host = createRuntimeTestHost({ workbench: false })

			await startCanvasFixture(host, [FontsPlugin, CanvasPlugin, CanvasTestConsumer], {
				maxTextCharacters: 4,
			})

			expect(() =>
				host.require(CanvasTestConsumer).canvas.prepareTextSync({ text: '12345' }),
			).toThrow(expect.objectContaining<Partial<CanvasError>>({ code: 'TEXT_TOO_LARGE' }))
		}
	})

	it('enforces allocation and decode boundaries before returning resources', async () => {
		{
			await using host = createRuntimeTestHost({ workbench: false })

			await startCanvasFixture(host, [FontsPlugin, CanvasPlugin, CanvasTestConsumer], {
				maxWidth: 100,
				maxHeight: 100,
				maxPixels: 1_000,
				maxImageBytes: 4,
			})
			const capability = host.require(CanvasTestConsumer).canvas
			const controller = new AbortController()
			controller.abort(new Error('request closed'))

			await expect(
				capability.decodeImage(new Uint8Array([1]), { signal: controller.signal }),
			).rejects.toThrow('request closed')
			await expect(capability.decodeImage(new Uint8Array([1, 2, 3]))).rejects.toMatchObject({
				code: 'INVALID_IMAGE',
			})
			expect(() => capability.createCanvasSync(101, 1)).toThrow(
				expect.objectContaining<Partial<CanvasError>>({ code: 'DIMENSIONS_EXCEEDED' }),
			)
			expect(() => capability.createCanvasSync(50, 50)).toThrow(
				expect.objectContaining<Partial<CanvasError>>({ code: 'PIXELS_EXCEEDED' }),
			)
			await expect(capability.decodeImage(new Uint8Array(5))).rejects.toMatchObject({
				code: 'IMAGE_BYTES_EXCEEDED',
			})
		}
	})

	it('places the provider-owned Fonts selection Attachment', async () => {
		{
			await using host = createRuntimeTestHost({ workbench: { enabled: true } })

			await startCanvasFixture(host, [FontsPlugin, CanvasPlugin])

			using selection = await host.workbench.open({
				target: CanvasPlugin,
				entry: CanvasWorkbench.fonts,
				principal: { provider: 'test', subject: 'canvas-tests' },
			})
			expect(selection).toMatchObject({
				kind: 'attachment',
				params: {},
				federatedViewRef: { expose: './views/selection' },
			})
			expect(await selection.provider.snapshot()).toMatchObject({
				defaultFont: host.require(CanvasPlugin).defaultFont,
				families: expect.any(Array),
			})
		}
	})
})
