import type { CanvasWorkerSnapshot } from '@pluxel/canvas/worker'
import { describe, expect, it } from 'vitest'
import type { RenderEngineInput } from '../src/render-engine.ts'
import {
	createEChartsWorkerHandler,
	type EChartsWorkerInput,
	type EChartsWorkerOutput,
} from '../src/worker.ts'

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

describe('ECharts worker rendering', () => {
	it('renders declarative SVG images through a fresh worker-local Canvas adapter', async () => {
		const response = await run(
			renderInput(
				imageOption([
					`data:image/svg+xml,${encodeURIComponent(
						'<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="#2563eb"/></svg>',
					)}`,
				]),
			),
		)

		expect(response).toMatchObject({
			ok: true,
			result: { mediaType: 'image/png', width: 32, height: 32 },
		})
		if (!response.ok) throw new Error('Expected the ECharts worker render to succeed')
		expect([...response.result.data.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
	})

	it('does not reinterpret ordinary data URL text as an image source', async () => {
		const response = await run(
			renderInput(
				{
					title: { text: 'data:text/plain,this-is-label-text' },
					xAxis: { type: 'category', data: ['A'] },
					yAxis: { type: 'value' },
					series: [{ type: 'bar', data: [1] }],
				},
				{ maxDataUrlBytes: 4 },
			),
		)

		expect(response).toMatchObject({ ok: true, result: { mediaType: 'image/png' } })
	})

	it('bounds distinct and aggregate image sources before native decode', async () => {
		const sources = ['#ef4444', '#22c55e', '#3b82f6'].map(
			(color) =>
				`data:image/svg+xml,${encodeURIComponent(
					`<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="${color}"/></svg>`,
				)}`,
		)

		const imageCountResponse = await run(
			renderInput(imageOption(sources), { maxImages: 2, maxTotalImagePixels: 20 }),
		)
		expect(imageCountResponse).toMatchObject({
			ok: false,
			error: { code: 'IMAGE_SOURCE_TOO_LARGE' },
		})

		const imageBytesResponse = await run(
			renderInput(
				imageOption([
					'data:application/octet-stream;base64,AA==',
					'data:application/octet-stream;base64,AQ==',
				]),
				{ maxImages: 2, maxTotalImageBytes: 1 },
			),
		)
		expect(imageBytesResponse).toMatchObject({
			ok: false,
			error: { code: 'IMAGE_SOURCE_TOO_LARGE' },
		})
	})

	it('checks encoded output before it leaves the worker boundary', async () => {
		const response = await run(
			renderInput(
				{
					xAxis: { type: 'category', data: ['A', 'B', 'C'] },
					yAxis: { type: 'value' },
					series: [{ type: 'bar', data: [3, 7, 5] }],
				},
				{ maxOutputBytes: 8 },
			),
		)

		expect(response).toMatchObject({
			ok: false,
			error: { code: 'OUTPUT_TOO_LARGE' },
		})
	})
})

async function run(render: RenderEngineInput): Promise<EChartsWorkerOutput> {
	return createEChartsWorkerHandler()({
		render,
		canvas: canvasSnapshot,
	} satisfies EChartsWorkerInput)
}

function renderInput(
	option: RenderEngineInput['option'],
	overrides: Partial<Omit<RenderEngineInput, 'option'>> = {},
): RenderEngineInput {
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
		...overrides,
	}
}

function imageOption(images: readonly string[]): RenderEngineInput['option'] {
	return {
		graphic: {
			elements: images.map((image, index) => ({
				type: 'image',
				left: index * 4,
				top: 0,
				style: { image, width: 4, height: 4 },
			})),
		},
	}
}
