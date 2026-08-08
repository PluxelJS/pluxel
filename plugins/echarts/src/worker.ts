import { GlobalFonts, Image, createCanvas, loadImage } from '@napi-rs/canvas'
import type { CanvasResourceLimits } from '@pluxel/canvas'
import { EChartsError, type EChartsErrorCode } from './errors.ts'
import {
	renderECharts,
	type RenderCanvasAdapter,
	type RenderEngineInput,
	type RenderEngineResult,
} from './render-engine.ts'

export type EChartsWorkerInput = Readonly<{
	render: RenderEngineInput
	canvasLimits: CanvasResourceLimits
	requiredFontFamily?: string
}>

export type EChartsWorkerOutput =
	| Readonly<{ ok: true; result: RenderEngineResult }>
	| Readonly<{
			ok: false
			error: Readonly<{ code: EChartsErrorCode; message: string }>
	  }>

const handler = async (input: EChartsWorkerInput): Promise<EChartsWorkerOutput> => {
	try {
		if (input.requiredFontFamily && !GlobalFonts.has(input.requiredFontFamily)) {
			throw new EChartsError(
				'RENDER_FAILED',
				`Selected font family "${input.requiredFontFamily}" is unavailable in the Canvas worker`,
			)
		}
		const result = await renderECharts(
			input.render,
			createNativeAdapter(input.canvasLimits, input.render.defaultFontCssFamily),
			new AbortController().signal,
		)
		return { ok: true, result }
	} catch (cause) {
		const error =
			cause instanceof EChartsError
				? cause
				: new EChartsError('RENDER_FAILED', 'Apache ECharts worker rendering failed', { cause })
		return { ok: false, error: { code: error.code, message: error.message } }
	}
}

export default handler

function createNativeAdapter(
	limits: CanvasResourceLimits,
	defaultFontCssFamily: string,
): RenderCanvasAdapter {
	return {
		createCanvas(width, height) {
			assertDimensions(width, height, limits)
			const canvas = createCanvas(width, height)
			canvas.getContext('2d').font = `10px ${defaultFontCssFamily}`
			return canvas as unknown as ReturnType<RenderCanvasAdapter['createCanvas']>
		},
		createImage() {
			return new Image() as unknown as ReturnType<RenderCanvasAdapter['createImage']>
		},
		async decodeImage(data) {
			if (!(data instanceof Uint8Array) || data.byteLength <= 0) {
				throw new EChartsError('INVALID_IMAGE_SOURCE', 'Image data must be non-empty bytes')
			}
			if (data.byteLength > limits.maxImageBytes) {
				throw new EChartsError(
					'IMAGE_SOURCE_TOO_LARGE',
					`Encoded image exceeds the configured ${limits.maxImageBytes} byte Canvas limit`,
				)
			}
			const image = await loadImage(Buffer.from(data))
			assertDimensions(image.width, image.height, limits)
			return image as unknown as Awaited<ReturnType<RenderCanvasAdapter['decodeImage']>>
		},
	}
}

function assertDimensions(width: number, height: number, limits: CanvasResourceLimits): void {
	if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
		throw new EChartsError('RENDER_FAILED', 'Canvas dimensions must be positive integers')
	}
	if (width > limits.maxWidth || height > limits.maxHeight) {
		throw new EChartsError(
			'RENDER_FAILED',
			`Canvas ${width}×${height} exceeds configured ${limits.maxWidth}×${limits.maxHeight} dimensions`,
		)
	}
	const pixels = width * height
	if (!Number.isSafeInteger(pixels) || pixels > limits.maxPixels) {
		throw new EChartsError(
			'RENDER_FAILED',
			`Canvas ${width}×${height} exceeds the configured ${limits.maxPixels} pixel limit`,
		)
	}
}
