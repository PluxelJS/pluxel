import { GlobalFonts } from '@napi-rs/canvas'
import {
	CanvasError,
	type CanvasResourceLimits,
	type CanvasTextResourceLimits,
	type CanvasWorkerFontSnapshot,
	type CanvasWorkerSnapshot,
} from './contracts.ts'

export function normalizeCanvasWorkerSnapshot(value: CanvasWorkerSnapshot): CanvasWorkerSnapshot {
	if (!value || typeof value !== 'object') {
		throw new CanvasError('INVALID_WORKER_SNAPSHOT', 'Canvas worker snapshot must be an object')
	}
	const limits = normalizeResourceLimits(value.limits)
	const textLimits = normalizeTextLimits(value.textLimits)
	const font = normalizeFontSnapshot(value.font)
	if (font.requiredFamily && !GlobalFonts.has(font.requiredFamily)) {
		throw new CanvasError(
			'FONT_UNAVAILABLE',
			`Selected font family "${font.requiredFamily}" is unavailable in the Canvas worker`,
		)
	}
	return Object.freeze({ limits, textLimits, font })
}

export function assertCanvasDimensions(
	width: number,
	height: number,
	limits: CanvasResourceLimits,
): void {
	if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
		throw new CanvasError('INVALID_DIMENSIONS', 'Canvas width and height must be positive integers')
	}
	if (width > limits.maxWidth || height > limits.maxHeight) {
		throw new CanvasError(
			'DIMENSIONS_EXCEEDED',
			`Canvas ${width}×${height} exceeds configured ${limits.maxWidth}×${limits.maxHeight} dimensions`,
		)
	}
	const pixels = width * height
	if (!Number.isSafeInteger(pixels) || pixels > limits.maxPixels) {
		throw new CanvasError(
			'PIXELS_EXCEEDED',
			`Canvas ${width}×${height} has ${pixels} pixels; the configured limit is ${limits.maxPixels}`,
		)
	}
}

function normalizeResourceLimits(value: CanvasResourceLimits): CanvasResourceLimits {
	if (!value || typeof value !== 'object') invalidSnapshot('limits must be an object')
	return Object.freeze({
		maxWidth: positiveInteger(value.maxWidth, 'limits.maxWidth'),
		maxHeight: positiveInteger(value.maxHeight, 'limits.maxHeight'),
		maxPixels: positiveInteger(value.maxPixels, 'limits.maxPixels'),
		maxImageBytes: positiveInteger(value.maxImageBytes, 'limits.maxImageBytes'),
	})
}

function normalizeTextLimits(value: CanvasTextResourceLimits): CanvasTextResourceLimits {
	if (!value || typeof value !== 'object') invalidSnapshot('textLimits must be an object')
	return Object.freeze({
		maxTextCharacters: positiveInteger(value.maxTextCharacters, 'textLimits.maxTextCharacters'),
		maxRichTextItems: positiveInteger(value.maxRichTextItems, 'textLimits.maxRichTextItems'),
		maxTextCacheCharacters: positiveInteger(
			value.maxTextCacheCharacters,
			'textLimits.maxTextCacheCharacters',
		),
	})
}

function normalizeFontSnapshot(value: CanvasWorkerFontSnapshot): CanvasWorkerFontSnapshot {
	if (!value || typeof value !== 'object') invalidSnapshot('font must be an object')
	const cssFamily = boundedText(value.cssFamily, 'font.cssFamily', 1_024)
	const revision = value.revision
	if (!Number.isSafeInteger(revision) || revision < 0) {
		invalidSnapshot('font.revision must be a non-negative safe integer')
	}
	const requiredFamily =
		value.requiredFamily === undefined
			? undefined
			: boundedText(value.requiredFamily, 'font.requiredFamily', 512)
	return Object.freeze({
		cssFamily,
		revision,
		...(requiredFamily === undefined ? {} : { requiredFamily }),
	})
}

function positiveInteger(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value <= 0)
		invalidSnapshot(`${name} must be a positive integer`)
	return value
}

function boundedText(value: string, name: string, maxLength: number): string {
	if (typeof value !== 'string') invalidSnapshot(`${name} must be text`)
	const normalized = value.trim()
	if (!normalized || normalized.length > maxLength || hasControlCharacters(normalized)) {
		invalidSnapshot(`${name} is empty or invalid`)
	}
	return normalized
}

function hasControlCharacters(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index)
		if (code <= 0x1f || code === 0x7f) return true
	}
	return false
}

function invalidSnapshot(message: string): never {
	throw new CanvasError('INVALID_WORKER_SNAPSHOT', `Canvas worker snapshot ${message}`)
}
