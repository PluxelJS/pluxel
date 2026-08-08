import {
	clearCache as clearPretextCache,
	prepare as prepareWithPretext,
	prepareWithSegments as prepareWithPretextSegments,
	type PreparedText,
	type PreparedTextWithSegments,
} from '@chenglou/pretext'
import {
	prepareRichInline as prepareRichInlineWithPretext,
	type PreparedRichInline,
} from '@chenglou/pretext/rich-inline'
import {
	createCanvas as createNativeCanvas,
	type Canvas,
	type SKRSContext2D,
} from '@napi-rs/canvas'
import {
	CanvasError,
	type CanvasRichInlineItem,
	type CanvasTextFontInput,
	type CanvasTextPreparationOptions,
	type CanvasWorkerSnapshot,
	type PrepareTextInput,
} from './contracts.ts'

export class CanvasTextLayoutController {
	private readonly cache = { characters: 0, fontRevision: -1 }

	prepareText(input: PrepareTextInput, snapshot: CanvasWorkerSnapshot): PreparedText {
		const normalized = normalizeTextInput(input, snapshot)
		return this.run(normalized.text.length, snapshot, () =>
			prepareWithPretext(normalized.text, normalized.font, normalized.options),
		)
	}

	prepareTextWithSegments(
		input: PrepareTextInput,
		snapshot: CanvasWorkerSnapshot,
	): PreparedTextWithSegments {
		const normalized = normalizeTextInput(input, snapshot)
		return this.run(normalized.text.length, snapshot, () =>
			prepareWithPretextSegments(normalized.text, normalized.font, normalized.options),
		)
	}

	prepareRichInline(
		items: readonly CanvasRichInlineItem[],
		snapshot: CanvasWorkerSnapshot,
	): PreparedRichInline {
		if (!Array.isArray(items) || items.length > snapshot.textLimits.maxRichTextItems) {
			throw new CanvasError(
				'TEXT_TOO_LARGE',
				`Rich text item count exceeds the configured limit of ${snapshot.textLimits.maxRichTextItems}`,
			)
		}
		let characters = 0
		const normalized = items.map((item, index) => {
			if (!item || typeof item !== 'object' || typeof item.text !== 'string') {
				throw new CanvasError('INVALID_TEXT', `Rich text item ${index} requires text`)
			}
			characters += item.text.length
			if (!Number.isSafeInteger(characters) || characters > snapshot.textLimits.maxTextCharacters) {
				throw new CanvasError(
					'TEXT_TOO_LARGE',
					`Rich text exceeds the configured ${snapshot.textLimits.maxTextCharacters} character limit`,
				)
			}
			const font = normalizeFont(item, snapshot)
			const letterSpacing = normalizeFiniteNumber(
				item.letterSpacing,
				`Rich text item ${index} letterSpacing`,
			)
			const extraWidth = normalizeFiniteNumber(
				item.extraWidth,
				`Rich text item ${index} extraWidth`,
			)
			if (item.break !== undefined && item.break !== 'normal' && item.break !== 'never') {
				throw new CanvasError('INVALID_TEXT', `Rich text item ${index} break mode is invalid`)
			}
			return {
				text: item.text,
				font,
				...(letterSpacing === undefined ? {} : { letterSpacing }),
				...(item.break === undefined ? {} : { break: item.break }),
				...(extraWidth === undefined ? {} : { extraWidth }),
			}
		})
		return this.run(characters, snapshot, () => prepareRichInlineWithPretext(normalized))
	}

	private run<T>(characters: number, snapshot: CanvasWorkerSnapshot, prepare: () => T): T {
		if (this.cache.fontRevision !== snapshot.font.revision) {
			clearPretextCache()
			this.cache.characters = 0
			this.cache.fontRevision = snapshot.font.revision
		}
		ensurePretextServerCanvas()
		if (
			this.cache.characters > 0 &&
			this.cache.characters + characters > snapshot.textLimits.maxTextCacheCharacters
		) {
			clearPretextCache()
			this.cache.characters = 0
		}
		const clearAfter = characters >= snapshot.textLimits.maxTextCacheCharacters
		try {
			const result = prepare()
			if (!clearAfter) this.cache.characters += characters
			return result
		} catch (cause) {
			throw new CanvasError('INVALID_TEXT', 'Pretext could not prepare the supplied text', {
				cause,
			})
		} finally {
			if (clearAfter) {
				clearPretextCache()
				this.cache.characters = 0
			}
		}
	}
}

let pretextServerCanvasReady = false

function ensurePretextServerCanvas(): void {
	if (pretextServerCanvasReady) return
	const globalRecord = globalThis as unknown as Record<PropertyKey, unknown>
	const previous = Object.getOwnPropertyDescriptor(globalThis, 'OffscreenCanvas')
	if (previous && !previous.configurable) {
		try {
			prepareWithPretext('', '10px sans-serif')
			pretextServerCanvasReady = true
			clearPretextCache()
			return
		} catch (cause) {
			throw new CanvasError(
				'TEXT_LAYOUT_UNAVAILABLE',
				'Pretext cannot use the host OffscreenCanvas implementation',
				{ cause },
			)
		}
	}
	class PretextOffscreenCanvas {
		private readonly native: Canvas

		constructor(width: number, height: number) {
			if (width !== 1 || height !== 1) {
				throw new CanvasError(
					'TEXT_LAYOUT_UNAVAILABLE',
					'Pretext requested an unexpected measurement canvas size',
				)
			}
			this.native = createNativeCanvas(width, height)
		}

		getContext(kind: string): SKRSContext2D | null {
			return kind === '2d' ? this.native.getContext('2d') : null
		}
	}
	try {
		Object.defineProperty(globalThis, 'OffscreenCanvas', {
			configurable: true,
			value: PretextOffscreenCanvas,
			writable: true,
		})
		prepareWithPretext('', '10px sans-serif')
		pretextServerCanvasReady = true
		clearPretextCache()
	} catch (cause) {
		throw cause instanceof CanvasError
			? cause
			: new CanvasError('TEXT_LAYOUT_UNAVAILABLE', 'Cannot initialize Pretext on server Canvas', {
					cause,
				})
	} finally {
		if (previous) Object.defineProperty(globalThis, 'OffscreenCanvas', previous)
		else delete globalRecord.OffscreenCanvas
	}
}

function normalizeTextInput(
	input: PrepareTextInput,
	snapshot: CanvasWorkerSnapshot,
): Readonly<{
	text: string
	font: string
	options: CanvasTextPreparationOptions
}> {
	if (!input || typeof input !== 'object' || typeof input.text !== 'string') {
		throw new CanvasError('INVALID_TEXT', 'Text preparation requires a text string')
	}
	if (input.text.length > snapshot.textLimits.maxTextCharacters) {
		throw new CanvasError(
			'TEXT_TOO_LARGE',
			`Text has ${input.text.length} characters; the configured limit is ${snapshot.textLimits.maxTextCharacters}`,
		)
	}
	if (
		input.whiteSpace !== undefined &&
		input.whiteSpace !== 'normal' &&
		input.whiteSpace !== 'pre-wrap'
	) {
		throw new CanvasError('INVALID_TEXT', 'whiteSpace must be normal or pre-wrap')
	}
	if (
		input.wordBreak !== undefined &&
		input.wordBreak !== 'normal' &&
		input.wordBreak !== 'keep-all'
	) {
		throw new CanvasError('INVALID_TEXT', 'wordBreak must be normal or keep-all')
	}
	const letterSpacing = normalizeFiniteNumber(input.letterSpacing, 'letterSpacing')
	return Object.freeze({
		text: input.text,
		font: normalizeFont(input, snapshot),
		options: Object.freeze({
			...(input.whiteSpace === undefined ? {} : { whiteSpace: input.whiteSpace }),
			...(input.wordBreak === undefined ? {} : { wordBreak: input.wordBreak }),
			...(letterSpacing === undefined ? {} : { letterSpacing }),
		}),
	})
}

function normalizeFont(input: CanvasTextFontInput, snapshot: CanvasWorkerSnapshot): string {
	if (input.font !== undefined) {
		if (typeof input.font !== 'string') {
			throw new CanvasError('INVALID_TEXT', 'font must be Canvas font shorthand text')
		}
		const font = input.font.trim()
		if (!font || font.length > 512 || hasControlCharacters(font)) {
			throw new CanvasError('INVALID_TEXT', 'font shorthand is empty or invalid')
		}
		if (input.fontSize !== undefined) {
			throw new CanvasError('INVALID_TEXT', 'font and fontSize are mutually exclusive')
		}
		return font
	}
	const fontSize = input.fontSize ?? 16
	if (!Number.isFinite(fontSize) || fontSize <= 0 || fontSize > 4_096) {
		throw new CanvasError('INVALID_TEXT', 'fontSize must be greater than 0 and at most 4096')
	}
	return `${fontSize}px ${snapshot.font.cssFamily}`
}

function normalizeFiniteNumber(value: unknown, label: string): number | undefined {
	if (value === undefined) return undefined
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		throw new CanvasError('INVALID_TEXT', `${label} must be a finite number`)
	}
	return value
}

function hasControlCharacters(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index)
		if (code <= 0x1f || code === 0x7f) return true
	}
	return false
}
