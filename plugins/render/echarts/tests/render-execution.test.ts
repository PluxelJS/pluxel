import {
	CanvasError,
	createCanvasWorkerAdapter,
	type CanvasWorkerAdapter,
	type CanvasWorkerSnapshot,
} from '@pluxel/canvas/worker'
import { v } from '@pluxel/runtime'
import { describe, expect, it } from 'vitest'
import { EChartsConfig } from '../src/config.ts'
import {
	renderECharts,
	type RenderCanvasAdapter,
	type RenderEngineInput,
	type RenderImage,
} from '../src/render-engine.ts'
import { createEChartsWorkerHandler, type EChartsWorkerInput } from '../src/worker.ts'

const canvasSnapshot = {
	limits: {
		maxWidth: 1_024,
		maxHeight: 1_024,
		maxPixels: 1_048_576,
		maxImageBytes: 1024 * 1024,
	},
	textLimits: {
		maxTextCharacters: 100_000,
		maxRichTextItems: 2_048,
		maxTextCacheCharacters: 1_000_000,
	},
	decodeLimits: { maxConcurrent: 1, maxQueued: 32 },
	font: { cssFamily: 'sans-serif', revision: 0 },
} satisfies CanvasWorkerSnapshot

const workerSignal = new AbortController().signal

describe('ECharts render execution settlement', () => {
	it('defaults aggregate decoded images to one maximum Canvas surface', () => {
		expect(v.parse(EChartsConfig, {}).maxTotalImagePixels).toBe(16_777_216)
	})

	it('aborts and waits for the remaining render-local image tasks after one image fails', async () => {
		const native = createCanvasWorkerAdapter(canvasSnapshot)
		const releaseAbortedDecodes = deferred<void>()
		const allPendingObservedAbort = deferred<void>()
		let rejectFirst!: (reason: Error) => void
		let decodeCalls = 0
		let aborts = 0
		const signals: AbortSignal[] = []
		const canvas: RenderCanvasAdapter = {
			createCanvas: (width, height) => native.createCanvas(width, height),
			createImage: () => native.createImage() as unknown as RenderImage,
			decodeImageInto: (image, _data, options) => {
				decodeCalls += 1
				const call = decodeCalls
				signals.push(options.signal)
				if (call === 1) {
					return new Promise<RenderImage>((_resolve, reject) => {
						rejectFirst = reject
					})
				}
				const pending = new Promise<RenderImage>((resolve, reject) => {
					options.signal.addEventListener(
						'abort',
						() => {
							aborts += 1
							if (aborts === 2) allPendingObservedAbort.resolve()
							void releaseAbortedDecodes.promise.then((): undefined => {
								if (call === 2) resolve(image)
								else reject(options.signal.reason)
								return undefined
							})
						},
						{ once: true },
					)
				})
				if (call === 3) rejectFirst(new Error('first image failed'))
				return pending
			},
		}
		const rendering = renderECharts(renderInput(imageOption(3)), canvas, workerSignal)
		let settled = false
		void rendering.then(
			(): undefined => {
				settled = true
				return undefined
			},
			(): undefined => {
				settled = true
				return undefined
			},
		)

		await allPendingObservedAbort.promise
		await new Promise<void>((resolve) => setImmediate(resolve))
		expect(settled).toBe(false)
		expect(signals).toHaveLength(3)
		expect(signals.every((signal) => signal.aborted)).toBe(true)

		releaseAbortedDecodes.resolve()
		await expect(rendering).rejects.toMatchObject({ code: 'IMAGE_LOAD_FAILED' })
		expect(settled).toBe(true)
		await native.close()
	})

	it('does not settle the worker handler until its Canvas adapter closes', async () => {
		const closeStarted = deferred<void>()
		const releaseClose = deferred<void>()
		const adapter = {
			snapshot: canvasSnapshot,
			async close() {
				closeStarted.resolve()
				await releaseClose.promise
			},
			createCanvas() {
				throw new CanvasError('NOT_RUNNING', 'controlled render failure')
			},
			createSvgCanvas() {
				throw new Error('unused')
			},
			createImage() {
				throw new Error('unused')
			},
			decodeImageInto() {
				return Promise.reject(new Error('unused'))
			},
			decodeImage() {
				return Promise.reject(new Error('unused'))
			},
		} as unknown as CanvasWorkerAdapter
		const handler = createEChartsWorkerHandler(() => adapter)
		const handling = handler({
			render: renderInput({}),
			canvas: canvasSnapshot,
		} satisfies EChartsWorkerInput)
		let settled = false
		void handling.then((): undefined => {
			settled = true
			return undefined
		})

		await closeStarted.promise
		await Promise.resolve()
		expect(settled).toBe(false)

		releaseClose.resolve()
		await expect(handling).resolves.toMatchObject({
			ok: false,
			error: { code: 'RENDER_FAILED' },
		})
	})
})

function renderInput(option: RenderEngineInput['option']): RenderEngineInput {
	return {
		width: 32,
		height: 32,
		devicePixelRatio: 1,
		option,
		theme: {},
		injectOptionFont: false,
		defaultFontCssFamily: 'sans-serif',
		output: { format: 'png' },
		maxDataUrlBytes: 1024,
		maxImages: 32,
		maxTotalImageBytes: 4_096,
		maxTotalImagePixels: 1_048_576,
		maxOutputBytes: 1024 * 1024,
	}
}

function imageOption(count: number): RenderEngineInput['option'] {
	return {
		graphic: {
			elements: Array.from({ length: count }, (_, index) => ({
				type: 'image',
				left: index,
				top: 0,
				style: {
					image: `data:application/octet-stream;base64,${Buffer.from([index]).toString('base64')}`,
					width: 1,
					height: 1,
				},
			})),
		},
	}
}

function deferred<T>(): Readonly<{
	promise: Promise<T>
	resolve(value: T | PromiseLike<T>): void
}> {
	let resolve!: (value: T | PromiseLike<T>) => void
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise
	})
	return { promise, resolve }
}
