import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { FontsPlugin } from '@pluxel/fonts'
import { requireWorkbench } from '@pluxel/runtime/internal'
import { type PluginConstructor } from '@pluxel/runtime'
import {
	BasePlugin,
	Plugin,
	pluginNodeAddressOf,
	type RuntimeHost,
	withRuntimeHost,
} from '@pluxel/runtime/test'
import { Renderer } from 'takumi-js/node'
import { describe, expect, it, vi } from 'vitest'
import { TakumiPlugin } from '../src/index.ts'
import { RenderScheduler } from '../src/render-scheduler.ts'

@Plugin()
class TakumiTestConsumer extends BasePlugin {
	constructor(
		readonly takumi: TakumiPlugin,
		readonly fonts: FontsPlugin,
	) {
		super()
	}
}

function addEnabled(host: RuntimeHost, plugins: readonly PluginConstructor[]): void {
	host.add(plugins)
	for (const PluginClass of plugins) host.cfg(PluginClass).enable()
}

const fontPath = findTestFont()

describe('TakumiPlugin', () => {
	it('renders bounded HTML to raster bytes and SVG without Workbench', async () => {
		await withRuntimeHost(
			async (host) => {
				addEnabled(host, [FontsPlugin, TakumiPlugin, TakumiTestConsumer])
				await host.commit()
				const takumi = host.require(TakumiTestConsumer).takumi

				const raster = await takumi.render({
					content:
						'<div style="display:flex;width:100%;height:100%;align-items:center;justify-content:center;background:#0f172a;color:white;font-size:32px">Pluxel</div>',
					width: 320,
					height: 180,
				})
				expect([...raster.data.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
				expect(raster).toMatchObject({
					mediaType: 'image/png',
					width: 320,
					height: 180,
					devicePixelRatio: 1,
				})
				const jpeg = await takumi.render({
					content: '<div style="background:white;color:black">JPEG</div>',
					width: 64,
					height: 32,
					output: { format: 'jpeg', quality: 80 },
				})
				expect([...jpeg.data.subarray(0, 3)]).toEqual([255, 216, 255])
				expect(jpeg.mediaType).toBe('image/jpeg')
				const webp = await takumi.render({
					content: '<div style="background:white;color:black">WebP</div>',
					width: 64,
					height: 32,
					output: { format: 'webp', lossless: true },
				})
				expect(webp.data.toString('ascii', 0, 4)).toBe('RIFF')
				expect(webp.data.toString('ascii', 8, 12)).toBe('WEBP')
				expect(webp.mediaType).toBe('image/webp')

				const svg = await takumi.renderSvg({
					content: '<div style="color:#2563eb;font-size:24px">Takumi SVG</div>',
					width: 320,
					height: 180,
				})
				expect(svg.mediaType).toBe('image/svg+xml')
				expect(svg.data).toContain('<svg')
				expect(host.ctx.workbench).toBeUndefined()
			},
			{ workbench: false },
		)
	})

	it.skipIf(!fontPath)('replays FontsPlugin portable resources by revision', async () => {
		await withRuntimeHost(
			async (host) => {
				addEnabled(host, [FontsPlugin, TakumiPlugin, TakumiTestConsumer])
				await host.commit()
				const consumer = host.require(TakumiTestConsumer)
				const family = `Pluxel Takumi ${crypto.randomUUID()}`
				const registration = await consumer.fonts.registerFromPath({ path: fontPath!, family })
				const snapshot = consumer.fonts.portableFonts
				expect(snapshot.fonts).toEqual([
					expect.objectContaining({ family, byteLength: expect.any(Number) }),
				])
				const id = snapshot.fonts[0]!.id
				const firstRead = await consumer.fonts.readPortableFont(id)
				const firstByte = firstRead[0]
				firstRead[0] = firstByte === 0 ? 1 : 0
				const secondRead = await consumer.fonts.readPortableFont(id)
				expect(secondRead[0]).toBe(firstByte)

				const rendered = await consumer.takumi.render({
					content: `<div style="font-family:'${family}';font-size:28px">Portable font</div>`,
					width: 360,
					height: 120,
				})
				expect(rendered.fontRevision).toBe(snapshot.revision)
				registration.dispose()
				expect(consumer.fonts.portableFonts.fonts).toEqual([])
				expect(consumer.fonts.portableFonts.revision).toBeGreaterThan(snapshot.revision)
			},
			{ workbench: false },
		)
	})

	it.skipIf(!fontPath)(
		'rejects portable font collections over the resource-count ceiling',
		async () => {
			await withRuntimeHost(
				async (host) => {
					addEnabled(host, [FontsPlugin, TakumiPlugin, TakumiTestConsumer])
					host.cfg(TakumiPlugin).set({ maxFonts: 0 })
					await host.commit()
					const consumer = host.require(TakumiTestConsumer)
					const registration = await consumer.fonts.registerFromPath({
						path: fontPath!,
						family: `Pluxel Takumi Count ${crypto.randomUUID()}`,
					})
					await expect(
						consumer.takumi.render({ content: '<div>font limit</div>', width: 10, height: 10 }),
					).rejects.toMatchObject({ code: 'FONT_COUNT_EXCEEDED' })
					registration.dispose()
				},
				{ workbench: false },
			)
		},
	)

	it('rejects over-budget pixels and blocks implicit remote image fetches', async () => {
		await withRuntimeHost(
			async (host) => {
				addEnabled(host, [FontsPlugin, TakumiPlugin, TakumiTestConsumer])
				host.cfg(TakumiPlugin).set({ maxPixels: 100 })
				await host.commit()
				const takumi = host.require(TakumiTestConsumer).takumi

				await expect(
					takumi.render({ content: '<div>large</div>', width: 20, height: 20 }),
				).rejects.toMatchObject({ code: 'PIXELS_EXCEEDED' })

				const fetchSpy = vi.spyOn(globalThis, 'fetch')
				try {
					await expect(
						takumi.render({
							content: '<img src="https://example.invalid/image.png">',
							width: 10,
							height: 10,
						}),
					).rejects.toMatchObject({ code: 'INVALID_IMAGE' })
					expect(fetchSpy).not.toHaveBeenCalled()
				} finally {
					fetchSpy.mockRestore()
				}
			},
			{ workbench: false },
		)
	})

	it('classifies an invalid cancellation signal as invalid input', async () => {
		await withRuntimeHost(
			async (host) => {
				addEnabled(host, [FontsPlugin, TakumiPlugin, TakumiTestConsumer])
				await host.commit()

				await expect(
					host.require(TakumiTestConsumer).takumi.render({
						content: '<div>invalid signal</div>',
						width: 10,
						height: 10,
						signal: {} as AbortSignal,
					}),
				).rejects.toMatchObject({ code: 'INVALID_INPUT' })
			},
			{ workbench: false },
		)
	})

	it('bounds structured node metadata before native rendering', async () => {
		await withRuntimeHost(
			async (host) => {
				addEnabled(host, [FontsPlugin, TakumiPlugin, TakumiTestConsumer])
				host.cfg(TakumiPlugin).set({ maxContentBytes: 128 })
				await host.commit()

				await expect(
					host.require(TakumiTestConsumer).takumi.render({
						content: {
							type: 'container',
							style: { backgroundImage: `url("${'x'.repeat(256)}")` },
						},
						width: 10,
						height: 10,
					}),
				).rejects.toMatchObject({ code: 'CONTENT_TOO_LARGE' })
			},
			{ workbench: false },
		)
	})

	it('bounds extracted stylesheets and distinct content image sources by count', async () => {
		await withRuntimeHost(
			async (host) => {
				addEnabled(host, [FontsPlugin, TakumiPlugin, TakumiTestConsumer])
				host.cfg(TakumiPlugin).set({ maxStylesheets: 1, maxImages: 1 })
				await host.commit()
				const takumi = host.require(TakumiTestConsumer).takumi

				await expect(
					takumi.render({
						content: '<style>.a{color:red}</style><style>.b{color:blue}</style><div>x</div>',
						width: 10,
						height: 10,
					}),
				).rejects.toMatchObject({ code: 'STYLESHEET_TOO_LARGE' })

				await expect(
					takumi.render({
						content: {
							type: 'container',
							children: [
								{ type: 'image', src: 'memory://one', width: 1, height: 1 },
								{ type: 'image', src: 'memory://two', width: 1, height: 1 },
							],
						},
						width: 10,
						height: 10,
					}),
				).rejects.toMatchObject({ code: 'INVALID_IMAGE' })
			},
			{ workbench: false },
		)
	})

	it('rejects structured accessors without invoking caller code', async () => {
		await withRuntimeHost(
			async (host) => {
				addEnabled(host, [FontsPlugin, TakumiPlugin, TakumiTestConsumer])
				await host.commit()
				let getterCalled = false
				const content = Object.defineProperty({ type: 'container' }, 'children', {
					enumerable: true,
					get() {
						getterCalled = true
						return []
					},
				})

				await expect(
					host.require(TakumiTestConsumer).takumi.render({
						content: content as never,
						width: 10,
						height: 10,
					}),
				).rejects.toMatchObject({ code: 'INVALID_INPUT' })
				expect(getterCalled).toBe(false)
			},
			{ workbench: false },
		)
	})

	it('requires node image bytes to use the bounded preloaded-images path', async () => {
		await withRuntimeHost(
			async (host) => {
				addEnabled(host, [FontsPlugin, TakumiPlugin, TakumiTestConsumer])
				await host.commit()

				await expect(
					host.require(TakumiTestConsumer).takumi.render({
						content: {
							type: 'image',
							src: new Uint8Array(new SharedArrayBuffer(4)),
							width: 1,
							height: 1,
						},
						width: 1,
						height: 1,
					}),
				).rejects.toMatchObject({ code: 'INVALID_IMAGE' })
			},
			{ workbench: false },
		)
	})

	it('forwards caller cancellation to Takumi native rendering', async () => {
		let nativeSignal: AbortSignal | undefined
		const nativeRender = vi
			.spyOn(Renderer.prototype, 'render')
			.mockImplementation(async (_node, options) => {
				nativeSignal = options?.signal
				return await new Promise<never>((_resolve, reject) => {
					if (nativeSignal?.aborted) {
						reject(nativeSignal.reason)
						return
					}
					nativeSignal?.addEventListener('abort', () => reject(nativeSignal!.reason), {
						once: true,
					})
				})
			})
		try {
			await withRuntimeHost(
				async (host) => {
					addEnabled(host, [FontsPlugin, TakumiPlugin, TakumiTestConsumer])
					await host.commit()
					const controller = new AbortController()
					const rendering = host.require(TakumiTestConsumer).takumi.render({
						content: '<div>cancel me</div>',
						width: 100,
						height: 100,
						signal: controller.signal,
					})

					await vi.waitFor(() => expect(nativeRender).toHaveBeenCalledOnce())
					expect(nativeSignal?.aborted).toBe(false)
					const reason = new DOMException('cancel test', 'AbortError')
					controller.abort(reason)
					expect(nativeSignal?.aborted).toBe(true)
					await expect(rendering).rejects.toBe(reason)
				},
				{ workbench: false },
			)
		} finally {
			nativeRender.mockRestore()
		}
	})

	it('cancels cooperative image snapshotting before native rendering', async () => {
		const nativeRender = vi.spyOn(Renderer.prototype, 'render')
		try {
			await withRuntimeHost(
				async (host) => {
					addEnabled(host, [FontsPlugin, TakumiPlugin, TakumiTestConsumer])
					await host.commit()
					const controller = new AbortController()
					const rendered = host.require(TakumiTestConsumer).takumi.render({
						content: '<img src="memory://image">',
						images: [{ src: 'memory://image', data: new Uint8Array(2 * 1024 * 1024) }],
						width: 10,
						height: 10,
						signal: controller.signal,
					})
					queueMicrotask(() => controller.abort())
					await expect(rendered).rejects.toMatchObject({ name: 'AbortError' })
					expect(nativeRender).not.toHaveBeenCalled()
				},
				{ workbench: false },
			)
		} finally {
			nativeRender.mockRestore()
		}
	})

	it('cancels cooperative SVG output measurement', async () => {
		const controller = new AbortController()
		const reason = new DOMException('cancel SVG measurement', 'AbortError')
		const nativeRender = vi.spyOn(Renderer.prototype, 'renderSvg').mockImplementation(async () => {
			setImmediate(() => controller.abort(reason))
			return `<svg>${'界'.repeat(1024 * 1024)}</svg>`
		})
		try {
			await withRuntimeHost(
				async (host) => {
					addEnabled(host, [FontsPlugin, TakumiPlugin, TakumiTestConsumer])
					await host.commit()
					await expect(
						host.require(TakumiTestConsumer).takumi.renderSvg({
							content: { type: 'text', text: 'SVG' },
							width: 10,
							height: 10,
							signal: controller.signal,
						}),
					).rejects.toBe(reason)
				},
				{ workbench: false },
			)
		} finally {
			nativeRender.mockRestore()
		}
	})

	it('enforces the host render deadline', async () => {
		const nativeRender = vi
			.spyOn(Renderer.prototype, 'render')
			.mockImplementation(async (_node, options) => {
				return await new Promise<never>((_resolve, reject) => {
					options?.signal?.addEventListener('abort', () => reject(options.signal!.reason), {
						once: true,
					})
				})
			})
		try {
			await withRuntimeHost(
				async (host) => {
					addEnabled(host, [FontsPlugin, TakumiPlugin, TakumiTestConsumer])
					host.cfg(TakumiPlugin).set({ maxRenderDurationMs: 10 })
					await host.commit()

					await expect(
						host.require(TakumiTestConsumer).takumi.render({
							content: '<div>deadline</div>',
							width: 100,
							height: 100,
						}),
					).rejects.toMatchObject({ code: 'RENDER_TIMEOUT' })
				},
				{ workbench: false },
			)
		} finally {
			nativeRender.mockRestore()
		}
	})

	it('mounts a provider-owned portable Fonts Port on the Takumi layout', async () => {
		await withRuntimeHost(
			async (host) => {
				addEnabled(host, [FontsPlugin, TakumiPlugin, TakumiTestConsumer])
				await host.commit()

				const layout = requireWorkbench(host.ctx).registry.getPluginLayout(
					pluginNodeAddressOf(TakumiPlugin),
				)
				expect(layout.items).toEqual([
					expect.objectContaining({
						owner: {
							address: pluginNodeAddressOf(FontsPlugin),
							displayName: 'FontsPlugin',
							rootExportName: 'FontsPlugin',
						},
						target: {
							address: pluginNodeAddressOf(TakumiPlugin),
							displayName: 'TakumiPlugin',
							rootExportName: 'TakumiPlugin',
						},
						viewId: 'FontSelection',
						port: expect.objectContaining({
							id: '@pluxel/fonts.selection',
							model: { selection: expect.objectContaining({ kind: 'rpc' }) },
						}),
					}),
				])
				const portable = await host
					.require(TakumiTestConsumer)
					.fonts.selectionManager('portable')
					.snapshot()
				expect(portable.families).toEqual([])
			},
			{ workbench: { enabled: true } },
		)
	})
})

describe('RenderScheduler', () => {
	it('bounds queues per owner and dispatches waiting owners round-robin', async () => {
		const scheduler = new RenderScheduler(1, 3, 2)
		const firstOwner = scheduler.createOwner()
		const secondOwner = scheduler.createOwner()
		const order: string[] = []
		let finishFirst!: () => void
		const first = scheduler.run(firstOwner, new AbortController().signal, async () => {
			order.push('first')
			await new Promise<void>((resolve) => {
				finishFirst = resolve
			})
			return 'first'
		})
		const second = scheduler.run(firstOwner, new AbortController().signal, async () => {
			order.push('second')
			return 'second'
		})
		const third = scheduler.run(firstOwner, new AbortController().signal, async () => {
			order.push('third')
			return 'third'
		})
		await expect(
			scheduler.run(firstOwner, new AbortController().signal, async () => 'overflow'),
		).rejects.toMatchObject({ code: 'RENDER_BUSY' })
		const other = scheduler.run(secondOwner, new AbortController().signal, async () => {
			order.push('other')
			return 'other'
		})

		await Promise.resolve()
		finishFirst()
		await expect(Promise.all([first, second, third, other])).resolves.toEqual([
			'first',
			'second',
			'third',
			'other',
		])
		expect(order).toEqual(['first', 'second', 'other', 'third'])
		await scheduler.close(new Error('test complete'))
	})

	it('rejects queued work and waits for active work when closed', async () => {
		const scheduler = new RenderScheduler(1, 1, 1)
		const owner = scheduler.createOwner()
		let finish!: () => void
		const active = scheduler.run(owner, new AbortController().signal, async () => {
			await new Promise<void>((resolve) => {
				finish = resolve
			})
		})
		const queued = scheduler.run(owner, new AbortController().signal, async (): Promise<void> => {})
		await Promise.resolve()
		const close = scheduler.close(new Error('scheduler stopped'))
		let closed = false
		void close.then((): undefined => {
			closed = true
			return undefined
		})

		await expect(queued).rejects.toThrow('scheduler stopped')
		await Promise.resolve()
		expect(closed).toBe(false)
		finish()
		await active
		await close
		expect(closed).toBe(true)
	})
})

function findTestFont(): string | undefined {
	const candidates = [
		'/usr/share/fonts/dejavu/DejaVuSans.ttf',
		'/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
		'/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf',
		'/System/Library/Fonts/Supplemental/Arial.ttf',
		process.env.WINDIR ? join(process.env.WINDIR, 'Fonts', 'arial.ttf') : '',
	]
	return candidates.find((candidate) => candidate && existsSync(candidate))
}
