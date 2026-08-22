import type { PluginConstructor } from '@pluxel/runtime'
import {
	BasePlugin,
	Plugin,
	pluginNodeAddressOf,
	type RuntimeHost,
	withRuntimeHost,
} from '@pluxel/runtime/test'
import type { WorkbenchLayout } from '@pluxel/runtime/workbench'
import {
	RUNTIME_INTERNAL_API_BASE,
	RUNTIME_WORKBENCH_PLUGIN_LAYOUT_BASE,
} from '@pluxel/runtime/web/paths'
import { describe, expect, it } from 'vitest'
import { GlobalFonts } from '@napi-rs/canvas'
import { FontsPlugin } from '@pluxel/fonts'
import { CanvasError, CanvasPlugin, layoutWithLines, measureRichInlineStats } from '../src/index.ts'
import { createCanvasWorkerAdapter } from '../src/worker.ts'
import { createCanvasWorkerTextLayout } from '../src/worker-pretext.ts'

function pluginLayoutUrl(address: unknown): URL {
	const url = new URL(
		`http://local.test${RUNTIME_INTERNAL_API_BASE}${RUNTIME_WORKBENCH_PLUGIN_LAYOUT_BASE}`,
	)
	url.searchParams.set('target', JSON.stringify(address))
	return url
}

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

function addEnabled(host: RuntimeHost, plugins: readonly PluginConstructor[]): void {
	host.add(plugins)
	for (const PluginClass of plugins) host.cfg(PluginClass).enable()
}

const discoveredFamily = GlobalFonts.families[0]?.family

describe('CanvasPlugin', () => {
	it('creates native raster and SVG canvases in a headless host', async () => {
		await withRuntimeHost(
			async (host) => {
				addEnabled(host, [FontsPlugin, CanvasPlugin, CanvasTestConsumer])
				await host.commit()
				const canvas = host.require(CanvasTestConsumer).canvas.createCanvas(64, 32)
				const context = canvas.getContext('2d')
				context.fillStyle = '#ff0000'
				context.fillRect(0, 0, canvas.width, canvas.height)
				const png = await canvas.encode('png')
				const svg = host.require(CanvasTestConsumer).canvas.createSvgCanvas(40, 20, {
					mode: 'compact',
				})
				svg.getContext('2d').fillRect(0, 0, 40, 20)

				expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
				expect(svg.getContent().toString()).toContain('<svg')
				expect(host.ctx.workbench.enabled).toBe(false)
			},
			{ workbench: false },
		)
	})

	it('creates a bounded native worker adapter from a detached host snapshot', async () => {
		await withRuntimeHost(
			async (host) => {
				addEnabled(host, [FontsPlugin, CanvasPlugin, CanvasTestConsumer])
				await host.commit()
				const capability = host.require(CanvasTestConsumer).canvas
				const snapshot = capability.workerSnapshot
				const workerCanvas = createCanvasWorkerAdapter(structuredClone(snapshot))
				const canvas = workerCanvas.createCanvas(24, 12)
				canvas.getContext('2d').fillRect(0, 0, 24, 12)
				const image = await workerCanvas.decodeImage(await canvas.encode('png'))
				const text = createCanvasWorkerTextLayout(structuredClone(snapshot))
				const prepared = text.prepareTextWithSegments({
					text: 'Worker 中的 Pretext 仍然使用统一字体快照',
					fontSize: 18,
				})

				expect({ width: image.width, height: image.height }).toEqual({ width: 24, height: 12 })
				expect(layoutWithLines(prepared, 100, 24).lineCount).toBeGreaterThan(1)
				expect(() =>
					text.prepareText({
						text: 'x'.repeat(snapshot.textLimits.maxTextCharacters + 1),
					}),
				).toThrowError(expect.objectContaining({ code: 'TEXT_TOO_LARGE' }))
				expect(workerCanvas.snapshot.font.cssFamily).toBe(snapshot.font.cssFamily)
				expect(Object.isFrozen(workerCanvas.snapshot.limits)).toBe(true)
				expect(capability.workerSnapshot).toBe(snapshot)
				expect(() => workerCanvas.createCanvas(snapshot.limits.maxWidth + 1, 1)).toThrowError(
					expect.objectContaining({ code: 'DIMENSIONS_EXCEEDED' }),
				)
			},
			{ workbench: false },
		)
	})

	it.skipIf(!discoveredFamily)(
		'applies Workbench default changes to subsequently created raster and SVG contexts',
		async () => {
			await withRuntimeHost(
				async (host) => {
					addEnabled(host, [FontsPlugin, CanvasPlugin, CanvasFontAdminConsumer])
					await host.commit()
					const consumer = host.require(CanvasFontAdminConsumer)
					const initialWorkerSnapshot = consumer.canvas.workerSnapshot

					await consumer.fonts.selectionManager().setDefaultFamily(discoveredFamily!)
					expect(consumer.canvas.createCanvas(2, 2).getContext('2d').font).toContain(
						discoveredFamily,
					)
					expect(consumer.canvas.workerSnapshot).not.toBe(initialWorkerSnapshot)
					expect(consumer.canvas.workerSnapshot.font.requiredFamily).toBe(discoveredFamily)

					await consumer.fonts.selectionManager().setDefaultFamily('monospace')
					expect(consumer.canvas.createSvgCanvas(2, 2).getContext('2d').font).toBe('10px monospace')
					expect(consumer.canvas.workerSnapshot.font.requiredFamily).toBeUndefined()
					expect(() =>
						createCanvasWorkerAdapter(consumer.canvas.workerSnapshot).createCanvas(2, 2),
					).not.toThrow()
				},
				{ workbench: false },
			)
		},
	)

	it('decodes caller-provided bytes without adding an outbound HTTP policy', async () => {
		await withRuntimeHost(
			async (host) => {
				addEnabled(host, [FontsPlugin, CanvasPlugin, CanvasTestConsumer])
				await host.commit()
				const capability = host.require(CanvasTestConsumer).canvas
				const source = capability.createCanvas(11, 7)
				const borrowedBytes = await source.encode('png')
				const borrowedDecode = capability.decodeImage(borrowedBytes)
				borrowedBytes.fill(0)
				const image = await borrowedDecode
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
			},
			{ workbench: false },
		)
	})

	it('uses bounded Pretext for multiline and rich-inline layout', async () => {
		await withRuntimeHost(
			async (host) => {
				addEnabled(host, [FontsPlugin, CanvasPlugin, CanvasTestConsumer])
				await host.commit()
				const capability = host.require(CanvasTestConsumer).canvas
				const prepared = capability.prepareTextWithSegments({
					text: 'Pluxel 可以正确处理多语言 canvas text layout',
					fontSize: 18,
				})
				const result = layoutWithLines(prepared, 120, 24)

				expect(result.lineCount).toBeGreaterThan(1)
				expect(result.height).toBe(result.lineCount * 24)
				expect(result.lines.map(({ text }) => text).join('')).toContain('Pluxel')
				const rich = capability.prepareRichInline([
					{ text: 'Ship ', fontSize: 16 },
					{ text: '@pluxel', font: '700 14px sans-serif', break: 'never', extraWidth: 12 },
				])
				expect(measureRichInlineStats(rich, 200)).toMatchObject({ lineCount: 1 })
			},
			{ workbench: false },
		)
	})

	it('rejects text before Pretext work when the host character budget is exceeded', async () => {
		await withRuntimeHost(
			async (host) => {
				addEnabled(host, [FontsPlugin, CanvasPlugin, CanvasTestConsumer])
				host.cfg(CanvasPlugin).set({ maxTextCharacters: 4 })
				await host.commit()

				expect(() =>
					host.require(CanvasTestConsumer).canvas.prepareText({ text: '12345' }),
				).toThrow(expect.objectContaining<Partial<CanvasError>>({ code: 'TEXT_TOO_LARGE' }))
			},
			{ workbench: false },
		)
	})

	it('enforces allocation and decode boundaries before returning resources', async () => {
		await withRuntimeHost(
			async (host) => {
				addEnabled(host, [FontsPlugin, CanvasPlugin, CanvasTestConsumer])
				host.cfg(CanvasPlugin).set({
					maxWidth: 100,
					maxHeight: 100,
					maxPixels: 1_000,
					maxImageBytes: 4,
				})
				await host.commit()
				const capability = host.require(CanvasTestConsumer).canvas
				const controller = new AbortController()
				controller.abort(new Error('request closed'))

				await expect(
					capability.decodeImage(new Uint8Array([1]), { signal: controller.signal }),
				).rejects.toThrow('request closed')
				await expect(capability.decodeImage(new Uint8Array([1, 2, 3]))).rejects.toMatchObject({
					code: 'INVALID_IMAGE',
				})
				expect(() => capability.createCanvas(101, 1)).toThrow(
					expect.objectContaining<Partial<CanvasError>>({ code: 'DIMENSIONS_EXCEEDED' }),
				)
				expect(() => capability.createCanvas(50, 50)).toThrow(
					expect.objectContaining<Partial<CanvasError>>({ code: 'PIXELS_EXCEEDED' }),
				)
				await expect(capability.decodeImage(new Uint8Array(5))).rejects.toMatchObject({
					code: 'IMAGE_BYTES_EXCEEDED',
				})
			},
			{ workbench: false },
		)
	})

	it('uses FontsPlugin as its direct Port renderer and resource owner', async () => {
		await withRuntimeHost(async (host) => {
			addEnabled(host, [FontsPlugin, CanvasPlugin])
			await host.commit()

			const response = await host.ctx.http.fetch(
				new Request(pluginLayoutUrl(pluginNodeAddressOf(CanvasPlugin))),
			)
			expect(response.status).toBe(200)
			const layout = (await response.json()) as WorkbenchLayout
			expect(layout.items).toEqual([
				expect.objectContaining({
					owner: {
						address: pluginNodeAddressOf(FontsPlugin),
						displayName: 'FontsPlugin',
						rootExportName: 'FontsPlugin',
					},
					target: {
						address: pluginNodeAddressOf(CanvasPlugin),
						displayName: 'CanvasPlugin',
						rootExportName: 'CanvasPlugin',
					},
					viewId: 'FontSelection',
					port: expect.objectContaining({
						id: '@pluxel/fonts.selection',
						model: { selection: expect.objectContaining({ kind: 'rpc' }) },
					}),
				}),
			])
		})
	})
})
