import { createCanvasWorkerAdapter, type CanvasWorkerSnapshot } from '@pluxel/canvas/worker'
import { bench, describe } from 'vitest'
import {
	renderECharts,
	type RenderCanvasAdapter,
	type RenderEngineInput,
} from '../src/render-engine.ts'

const canvas = createCanvasWorkerAdapter({
	limits: {
		maxWidth: 8_192,
		maxHeight: 8_192,
		maxPixels: 16_777_216,
		maxImageBytes: 32 * 1024 * 1024,
	},
	textLimits: {
		maxTextCharacters: 100_000,
		maxRichTextItems: 2_048,
		maxTextCacheCharacters: 1_000_000,
	},
	decodeLimits: { maxConcurrent: 4, maxQueued: 8 },
	font: { cssFamily: 'sans-serif', revision: 0 },
} satisfies CanvasWorkerSnapshot)
const signal = new AbortController().signal
const input = {
	width: 320,
	height: 180,
	devicePixelRatio: 1,
	option: {
		xAxis: { type: 'category', data: Array.from({ length: 500 }, (_, index) => String(index)) },
		yAxis: { type: 'value' },
		series: [{ type: 'line', data: Array.from({ length: 500 }, (_, index) => index % 97) }],
	},
	theme: { textStyle: { fontFamily: 'sans-serif' } },
	injectOptionFont: false,
	defaultFontCssFamily: 'sans-serif',
	fontRevision: 0,
	output: { format: 'png' },
	maxDataUrlBytes: 32 * 1024 * 1024,
	maxImages: 32,
	maxTotalImageBytes: 32 * 1024 * 1024,
	maxTotalImagePixels: 67_108_864,
	maxOutputBytes: 64 * 1024 * 1024,
} satisfies RenderEngineInput

describe('ECharts worker render engine', () => {
	bench('owned option traversal', async () => {
		await renderECharts(input, canvas as unknown as RenderCanvasAdapter, signal)
	})
})
