import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { FontsPlugin } from '@pluxel/fonts'
import {
	BasePlugin,
	Plugin,
	createRuntimeTestHost,
	type RawPluginConfig,
	type RuntimeTestHost,
} from '@pluxel/runtime/test'
import { Renderer } from 'takumi-js/node'
import { describe, expect, it, vi } from 'vitest'
import { TakumiPlugin } from '../src/index.ts'
import { RenderScheduler } from '../src/render-scheduler.ts'
import { TakumiWorkbench } from '../src/workbench.ts'

@Plugin()
class TakumiTestConsumer extends BasePlugin {
	constructor(
		readonly takumi: TakumiPlugin,
		readonly fonts: FontsPlugin,
	) {
		super()
	}
}

function startTakumiFixture(host: RuntimeTestHost, initialConfig?: RawPluginConfig): Promise<void> {
	return host.commit((change) => {
		change.catalog.add([FontsPlugin, TakumiPlugin, TakumiTestConsumer])
		if (initialConfig) change.config.seed(TakumiPlugin, initialConfig)
		change.start(FontsPlugin)
		change.start(TakumiPlugin)
		change.start(TakumiTestConsumer)
	})
}

const fontPath = findTestFont()

describe('TakumiPlugin', () => {
	it('renders bounded HTML to raster bytes and SVG without Workbench', async () => {
		{
			await using host = createRuntimeTestHost()

			await startTakumiFixture(host)
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
		}
	})

	it.skipIf(!fontPath)('replays FontsPlugin portable resources by revision', async () => {
		{
			await using host = createRuntimeTestHost()

			await startTakumiFixture(host)
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
		}
	})

	it.skipIf(!fontPath)(
		'rejects portable font collections over the resource-count ceiling',
		async () => {
			{
				await using host = createRuntimeTestHost()

				await startTakumiFixture(host, { maxFonts: 0 })
				const consumer = host.require(TakumiTestConsumer)
				const registration = await consumer.fonts.registerFromPath({
					path: fontPath!,
					family: `Pluxel Takumi Count ${crypto.randomUUID()}`,
				})
				await expect(
					consumer.takumi.render({ content: '<div>font limit</div>', width: 10, height: 10 }),
				).rejects.toMatchObject({ code: 'FONT_COUNT_EXCEEDED' })
				registration.dispose()
			}
		},
	)

	it('rejects over-budget pixels and blocks implicit remote image fetches', async () => {
		{
			await using host = createRuntimeTestHost()

			await startTakumiFixture(host, { maxPixels: 100 })
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
		}
	})

	it('classifies an invalid cancellation signal as invalid input', async () => {
		{
			await using host = createRuntimeTestHost()

			await startTakumiFixture(host)

			await expect(
				host.require(TakumiTestConsumer).takumi.render({
					content: '<div>invalid signal</div>',
					width: 10,
					height: 10,
					signal: {} as AbortSignal,
				}),
			).rejects.toMatchObject({ code: 'INVALID_INPUT' })
		}
	})

	it('bounds structured node metadata before native rendering', async () => {
		{
			await using host = createRuntimeTestHost()

			await startTakumiFixture(host, { maxContentBytes: 128 })

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
		}
	})

	it('bounds extracted stylesheets and distinct content image sources by count', async () => {
		{
			await using host = createRuntimeTestHost()

			await startTakumiFixture(host, { maxStylesheets: 1, maxImages: 1 })
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
		}
	})

	it('rejects structured accessors without invoking caller code', async () => {
		{
			await using host = createRuntimeTestHost()

			await startTakumiFixture(host)
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
		}
	})

	it('requires node image bytes to use the bounded preloaded-images path', async () => {
		{
			await using host = createRuntimeTestHost()

			await startTakumiFixture(host)

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
		}
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
			{
				await using host = createRuntimeTestHost()

				await startTakumiFixture(host)
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
			}
		} finally {
			nativeRender.mockRestore()
		}
	})

	it('discards raster output when cancellation cannot preempt running native work', async () => {
		let releaseNative!: () => void
		const nativeRender = vi.spyOn(Renderer.prototype, 'render').mockImplementation(async () => {
			await new Promise<void>((resolve) => {
				releaseNative = resolve
			})
			return Buffer.from([1, 2, 3])
		})
		try {
			{
				await using host = createRuntimeTestHost()

				await startTakumiFixture(host)
				const controller = new AbortController()
				const rendering = host.require(TakumiTestConsumer).takumi.render({
					content: '<div>already running</div>',
					width: 100,
					height: 100,
					signal: controller.signal,
				})

				await vi.waitFor(() => expect(nativeRender).toHaveBeenCalledOnce())
				const reason = new DOMException('discard late output', 'AbortError')
				controller.abort(reason)
				releaseNative()
				await expect(rendering).rejects.toBe(reason)
			}
		} finally {
			nativeRender.mockRestore()
		}
	})

	it('cancels cooperative image snapshotting before native rendering', async () => {
		const nativeRender = vi.spyOn(Renderer.prototype, 'render')
		try {
			{
				await using host = createRuntimeTestHost()

				await startTakumiFixture(host)
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
			}
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
			{
				await using host = createRuntimeTestHost()

				await startTakumiFixture(host)
				await expect(
					host.require(TakumiTestConsumer).takumi.renderSvg({
						content: { type: 'text', text: 'SVG' },
						width: 10,
						height: 10,
						signal: controller.signal,
					}),
				).rejects.toBe(reason)
			}
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
			{
				await using host = createRuntimeTestHost()

				await startTakumiFixture(host, { maxRenderDurationMs: 10 })

				await expect(
					host.require(TakumiTestConsumer).takumi.render({
						content: '<div>deadline</div>',
						width: 100,
						height: 100,
					}),
				).rejects.toMatchObject({ code: 'RENDER_TIMEOUT' })
			}
		} finally {
			nativeRender.mockRestore()
		}
	})

	it('places the provider-owned Fonts selection Attachment', async () => {
		{
			await using host = createRuntimeTestHost({ workbench: { enabled: true } })

			await startTakumiFixture(host)

			using opened = await host.workbench.open({
				target: TakumiPlugin,
				entry: TakumiWorkbench.fonts,
				principal: { provider: 'test', subject: 'takumi-tests' },
			})
			expect(opened).toMatchObject({
				kind: 'attachment',
				params: {},
				federatedViewRef: {
					profile: 1,
					descriptor: {
						kind: 'attachment',
						key: 'selection',
					},
				},
			})
			await expect(opened.provider.snapshot()).resolves.toMatchObject({
				defaultFont: { family: expect.any(String) },
			})
		}
	})
})

describe('Takumi render reservations', () => {
	it('holds fair capacity before preparation and releases an uncommitted reservation', async () => {
		await using host = createRuntimeTestHost()
		await startTakumiFixture(host, {
			maxConcurrentRenders: 1,
			maxQueuedRenders: 0,
			maxQueuedRendersPerConsumer: 0,
		})
		const takumi = host.require(TakumiTestConsumer).takumi
		const reservation = await takumi.reserveRender()
		try {
			await expect(takumi.reserveRender()).rejects.toMatchObject({ code: 'RENDER_BUSY' })
		} finally {
			await reservation.close()
		}

		const replacement = await takumi.reserveRender()
		await replacement.close()
	})

	it('releases an aborted uncommitted reservation and rejects its commit with the abort reason', async () => {
		await using host = createRuntimeTestHost()
		await startTakumiFixture(host)
		const controller = new AbortController()
		const reservation = await host
			.require(TakumiTestConsumer)
			.takumi.reserveRender({ signal: controller.signal })
		const reason = new DOMException('reservation cancelled', 'AbortError')
		controller.abort(reason)

		await expect(
			reservation.render({ content: '<div>cancelled</div>', width: 10, height: 10 }),
		).rejects.toBe(reason)
		await reservation.close()
		const replacement = await host.require(TakumiTestConsumer).takumi.reserveRender()
		await replacement.close()
	})

	it('withdraws reservation handles when their caller generation restarts', async () => {
		await using host = createRuntimeTestHost()
		await startTakumiFixture(host)
		const reservation = await host.require(TakumiTestConsumer).takumi.reserveRender()

		await host.restart(TakumiTestConsumer)
		await expect(
			reservation.render({ content: '<div>stale</div>', width: 10, height: 10 }),
		).rejects.toMatchObject({ code: 'NOT_RUNNING' })
		await reservation.close()
		const replacement = await host.require(TakumiTestConsumer).takumi.reserveRender()
		await replacement.close()
	})

	it('keeps committed capacity until non-preemptible native work settles', async () => {
		let releaseNative!: () => void
		const nativeRender = vi.spyOn(Renderer.prototype, 'render').mockImplementation(async () => {
			await new Promise<void>((resolve) => {
				releaseNative = resolve
			})
			return Buffer.from([1, 2, 3])
		})
		try {
			await using host = createRuntimeTestHost()
			await startTakumiFixture(host, {
				maxConcurrentRenders: 1,
				maxQueuedRenders: 0,
				maxQueuedRendersPerConsumer: 0,
			})
			const takumi = host.require(TakumiTestConsumer).takumi
			const reservation = await takumi.reserveRender()
			const rendering = reservation.render({
				content: '<div>native work</div>',
				width: 10,
				height: 10,
			})
			await vi.waitFor(() => expect(nativeRender).toHaveBeenCalledOnce())

			let closed = false
			const closing = reservation.close().then((): void => {
				closed = true
				return undefined
			})
			await Promise.resolve()
			expect(closed).toBe(false)
			await expect(takumi.reserveRender()).rejects.toMatchObject({ code: 'RENDER_BUSY' })

			releaseNative()
			await expect(rendering).rejects.toMatchObject({ code: 'NOT_RUNNING' })
			await closing
			expect(closed).toBe(true)
			const replacement = await takumi.reserveRender()
			await replacement.close()
		} finally {
			nativeRender.mockRestore()
		}
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
