import {
	clearCache as clearPretextCache,
	layout,
	layoutNextLine,
	layoutNextLineRange,
	layoutWithLines,
	materializeLineRange,
	measureLineStats,
	measureNaturalWidth,
	prepare as prepareWithPretext,
	prepareWithSegments as prepareWithPretextSegments,
	walkLineRanges,
	type LayoutCursor,
	type LayoutLine,
	type LayoutLineRange,
	type LayoutLinesResult,
	type LayoutResult,
	type LineStats,
	type PreparedText,
	type PreparedTextWithSegments,
} from '@chenglou/pretext'
import {
	layoutNextRichInlineLineRange,
	materializeRichInlineLineRange,
	measureRichInlineStats,
	prepareRichInline as prepareRichInlineWithPretext,
	walkRichInlineLineRanges,
	type PreparedRichInline,
	type RichInlineCursor,
	type RichInlineFragment,
	type RichInlineFragmentRange,
	type RichInlineLine,
	type RichInlineLineRange,
	type RichInlineStats,
} from '@chenglou/pretext/rich-inline'
import {
	DOMMatrix,
	DOMPoint,
	DOMRect,
	FillType,
	Image as NativeImage,
	Path2D,
	PathOp,
	StrokeCap,
	StrokeJoin,
	SvgExportFlag,
	createCanvas as createNativeCanvas,
	loadImage as loadNativeImage,
	type Canvas,
	type Image,
	type SKRSContext2D,
	type SvgCanvas,
} from '@napi-rs/canvas'
import { FontsPlugin, type DefaultFontSnapshot } from '@pluxel/fonts'
import { FontsSelectionPort } from '@pluxel/fonts/workbench'
import { BasePlugin, Plugin, type Context } from '@pluxel/runtime'
import { workbench } from '@pluxel/runtime/workbench'
import { workbenchContract } from '@pluxel/runtime/workbench/contract'
import { CanvasConfig, type CanvasPluginConfig } from './config.ts'

const CanvasWorkbench = workbench.portOutlet({
	id: 'Fonts',
	port: FontsSelectionPort,
	placement: workbenchContract.tab({
		label: 'Fonts',
		icon: workbenchContract.icons.Typography,
	}),
})

export type SvgCanvasOptions = Readonly<{
	/**
	 * Upstream exposes these as mutually exclusive enum variants rather than combinable flags.
	 * @defaultValue 'compact'
	 */
	mode?: 'text-to-paths' | 'compact' | 'relative-paths'
}>

export type DecodeImageOptions = Readonly<{
	/**
	 * Stops waiting for the native decode. The current upstream decoder cannot cancel work already
	 * submitted to native code, so a late result is discarded.
	 */
	signal?: AbortSignal
}>

type TextFontInput =
	| Readonly<{
			/** Full Canvas font shorthand. When present it owns both size and family. */
			font: string
			fontSize?: never
	  }>
	| Readonly<{
			/** Font size paired with the current Pluxel default family. @defaultValue 16 */
			font?: never
			fontSize?: number
	  }>

type TextPreparationOptions = Readonly<{
	whiteSpace?: 'normal' | 'pre-wrap'
	wordBreak?: 'normal' | 'keep-all'
	/** CSS pixel value matching the eventual renderer. @defaultValue 0 */
	letterSpacing?: number
}>

export type PrepareTextInput = Readonly<{
	text: string
}> &
	TextFontInput &
	TextPreparationOptions

export type CanvasRichInlineItem = Readonly<{
	text: string
	letterSpacing?: number
	break?: 'normal' | 'never'
	extraWidth?: number
}> &
	TextFontInput

export type CanvasErrorCode =
	| 'NOT_RUNNING'
	| 'INVALID_DIMENSIONS'
	| 'DIMENSIONS_EXCEEDED'
	| 'PIXELS_EXCEEDED'
	| 'INVALID_IMAGE'
	| 'IMAGE_BYTES_EXCEEDED'
	| 'INVALID_TEXT'
	| 'TEXT_TOO_LARGE'
	| 'TEXT_LAYOUT_UNAVAILABLE'

export class CanvasError extends Error {
	override readonly name = 'CanvasError'

	constructor(
		readonly code: CanvasErrorCode,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options)
	}
}

type CanvasLease = {
	readonly owner: Context
	readonly generation: object
	readonly controller: AbortController
	active: boolean
}

@Plugin({ name: 'CanvasPlugin' })
export class CanvasPlugin extends BasePlugin {
	private readonly config = this.configs.use(CanvasConfig)
	private readonly leases = new Set<CanvasLease>()
	private readonly leasesByOwner = new WeakMap<Context, CanvasLease>()
	private readonly textLayoutState = { characters: 0, fontRevision: -1 }
	private generation?: object

	constructor(private readonly fonts: FontsPlugin) {
		super()
	}

	override async init(): Promise<void> {
		const generation = Object.freeze({})
		this.generation = generation
		this.ctx.effects.defer(
			() => {
				if (this.generation === generation) this.generation = undefined
				for (const lease of this.leases) this.closeLease(lease)
			},
			{ tag: 'canvas-generation' },
		)
		this.ctx.workbench.mount(CanvasWorkbench, {
			selection: workbench.bind.rpc(() => this.fonts.selectionManager()),
		})
	}

	/** Current provider-wide default used for newly created contexts. */
	get defaultFont(): DefaultFontSnapshot {
		this.requireLease()
		return this.fonts.defaultFont
	}

	/**
	 * Creates a native raster Canvas after enforcing the host's initial allocation budget.
	 * The returned native object is caller-owned and may be resized independently afterwards.
	 */
	createCanvas(width: number, height: number): Canvas {
		this.requireLease()
		this.assertDimensions(width, height)
		const canvas = createNativeCanvas(width, height)
		this.applyDefaultFont(canvas)
		return canvas
	}

	/** Creates an unloaded native Image for synchronous platform adapter contracts. */
	createImage(): Image {
		this.requireLease()
		return new NativeImage()
	}

	/** Creates a native SVG Canvas after enforcing the same dimension and pixel budget. */
	createSvgCanvas(width: number, height: number, options: SvgCanvasOptions = {}): SvgCanvas {
		this.requireLease()
		this.assertDimensions(width, height)
		const flags =
			options.mode === 'text-to-paths'
				? SvgExportFlag.ConvertTextToPaths
				: options.mode === 'relative-paths'
					? SvgExportFlag.RelativePathEncoding
					: SvgExportFlag.NoPrettyXML
		const canvas = createNativeCanvas(width, height, flags)
		this.applyDefaultFont(canvas)
		return canvas
	}

	/**
	 * Decodes caller-provided image bytes. Fetch remote images through an outbound HTTP capability
	 * first so authentication, retry, origin policy and cancellation remain owned by that caller.
	 */
	async decodeImage(data: Uint8Array, options: DecodeImageOptions = {}): Promise<Image> {
		const lease = this.requireLease()
		if (!(data instanceof Uint8Array) || data.byteLength <= 0) {
			throw new CanvasError('INVALID_IMAGE', 'decodeImage() requires non-empty Uint8Array data')
		}
		if (data.byteLength > this.config.maxImageBytes) {
			throw new CanvasError(
				'IMAGE_BYTES_EXCEEDED',
				`Encoded image is ${data.byteLength} bytes; the configured limit is ${this.config.maxImageBytes}`,
			)
		}
		if (options.signal?.aborted) throw abortReason(options.signal)
		const task = decodeNativeImage(data)
		const image = await waitForDecode(task, [lease.controller.signal, options.signal])
		if (!lease.active || this.generation !== lease.generation) {
			throw new CanvasError(
				'NOT_RUNNING',
				'Canvas capability belongs to a stopped plugin generation',
			)
		}
		this.assertDimensions(image.width, image.height)
		return image
	}

	/**
	 * Measures and segments text with Pretext. Omitting `font` uses the current Pluxel default
	 * family at `fontSize` (16px by default). Existing prepared values remain immutable when the
	 * default font changes.
	 */
	prepareText(input: PrepareTextInput): PreparedText {
		const normalized = this.normalizeTextInput(input)
		return this.runTextPreparation(normalized.text.length, () =>
			prepareWithPretext(normalized.text, normalized.font, normalized.options),
		)
	}

	/** Prepares the richer Pretext representation required for manual Canvas line rendering. */
	prepareTextWithSegments(input: PrepareTextInput): PreparedTextWithSegments {
		const normalized = this.normalizeTextInput(input)
		return this.runTextPreparation(normalized.text.length, () =>
			prepareWithPretextSegments(normalized.text, normalized.font, normalized.options),
		)
	}

	/** Prepares inline fragments while applying the Pluxel default family to items without `font`. */
	prepareRichInline(items: readonly CanvasRichInlineItem[]): PreparedRichInline {
		this.requireLease()
		if (!Array.isArray(items) || items.length > this.config.maxRichTextItems) {
			throw new CanvasError(
				'TEXT_TOO_LARGE',
				`Rich text item count exceeds the configured limit of ${this.config.maxRichTextItems}`,
			)
		}
		let characters = 0
		const normalized = items.map((item, index) => {
			if (!item || typeof item !== 'object' || typeof item.text !== 'string') {
				throw new CanvasError('INVALID_TEXT', `Rich text item ${index} requires text`)
			}
			characters += item.text.length
			if (!Number.isSafeInteger(characters) || characters > this.config.maxTextCharacters) {
				throw new CanvasError(
					'TEXT_TOO_LARGE',
					`Rich text exceeds the configured ${this.config.maxTextCharacters} character limit`,
				)
			}
			const font = this.normalizeFont(item)
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
		return this.runTextPreparation(characters, () => prepareRichInlineWithPretext(normalized))
	}

	private requireLease(): CanvasLease {
		const generation = this.generation
		if (!generation) throw new CanvasError('NOT_RUNNING', 'CanvasPlugin is not running')
		const owner = this.ctx.caller ?? this.ctx
		const existing = this.leasesByOwner.get(owner)
		if (existing) {
			if (!existing.active || existing.generation !== generation) {
				throw new CanvasError(
					'NOT_RUNNING',
					'Canvas capability belongs to a stopped plugin generation',
				)
			}
			return existing
		}
		const lease: CanvasLease = {
			owner,
			generation,
			controller: new AbortController(),
			active: true,
		}
		this.leases.add(lease)
		this.leasesByOwner.set(owner, lease)
		try {
			owner.effects.defer(() => this.closeLease(lease), { tag: 'canvas-caller' })
		} catch (cause) {
			this.closeLease(lease)
			throw new CanvasError('NOT_RUNNING', 'Canvas caller is stopped or being replaced', { cause })
		}
		return lease
	}

	private closeLease(lease: CanvasLease): void {
		if (!lease.active) return
		lease.active = false
		lease.controller.abort(
			new CanvasError('NOT_RUNNING', 'Canvas capability belongs to a stopped plugin generation'),
		)
		this.leases.delete(lease)
		if (this.leasesByOwner.get(lease.owner) === lease) this.leasesByOwner.delete(lease.owner)
	}

	private assertDimensions(width: number, height: number): void {
		if (
			!Number.isSafeInteger(width) ||
			!Number.isSafeInteger(height) ||
			width <= 0 ||
			height <= 0
		) {
			throw new CanvasError(
				'INVALID_DIMENSIONS',
				'Canvas width and height must be positive integers',
			)
		}
		if (width > this.config.maxWidth || height > this.config.maxHeight) {
			throw new CanvasError(
				'DIMENSIONS_EXCEEDED',
				`Canvas ${width}×${height} exceeds configured ${this.config.maxWidth}×${this.config.maxHeight} dimensions`,
			)
		}
		const pixels = width * height
		if (!Number.isSafeInteger(pixels) || pixels > this.config.maxPixels) {
			throw new CanvasError(
				'PIXELS_EXCEEDED',
				`Canvas ${width}×${height} has ${pixels} pixels; the configured limit is ${this.config.maxPixels}`,
			)
		}
	}

	private applyDefaultFont(canvas: Canvas | SvgCanvas): void {
		canvas.getContext('2d').font = `10px ${this.fonts.defaultFont.cssFamily}`
	}

	private normalizeTextInput(input: PrepareTextInput): Readonly<{
		text: string
		font: string
		options: TextPreparationOptions
	}> {
		this.requireLease()
		if (!input || typeof input !== 'object' || typeof input.text !== 'string') {
			throw new CanvasError('INVALID_TEXT', 'Text preparation requires a text string')
		}
		if (input.text.length > this.config.maxTextCharacters) {
			throw new CanvasError(
				'TEXT_TOO_LARGE',
				`Text has ${input.text.length} characters; the configured limit is ${this.config.maxTextCharacters}`,
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
			font: this.normalizeFont(input),
			options: Object.freeze({
				...(input.whiteSpace === undefined ? {} : { whiteSpace: input.whiteSpace }),
				...(input.wordBreak === undefined ? {} : { wordBreak: input.wordBreak }),
				...(letterSpacing === undefined ? {} : { letterSpacing }),
			}),
		})
	}

	private normalizeFont(input: TextFontInput): string {
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
		return `${fontSize}px ${this.fonts.defaultFont.cssFamily}`
	}

	private runTextPreparation<T>(characters: number, prepare: () => T): T {
		this.requireLease()
		const fontRevision = this.fonts.revision
		if (this.textLayoutState.fontRevision !== fontRevision) {
			clearPretextCache()
			this.textLayoutState.characters = 0
			this.textLayoutState.fontRevision = fontRevision
		}
		ensurePretextServerCanvas(this)
		if (
			this.textLayoutState.characters > 0 &&
			this.textLayoutState.characters + characters > this.config.maxTextCacheCharacters
		) {
			clearPretextCache()
			this.textLayoutState.characters = 0
		}
		const clearAfter = characters >= this.config.maxTextCacheCharacters
		try {
			const result = prepare()
			if (!clearAfter) this.textLayoutState.characters += characters
			return result
		} catch (cause) {
			throw new CanvasError('INVALID_TEXT', 'Pretext could not prepare the supplied text', {
				cause,
			})
		} finally {
			if (clearAfter) {
				clearPretextCache()
				this.textLayoutState.characters = 0
			}
		}
	}
}

let pretextServerCanvasReady = false

function ensurePretextServerCanvas(canvas: CanvasPlugin): void {
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
			this.native = canvas.createCanvas(width, height)
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

async function waitForDecode<T>(
	task: Promise<T>,
	signals: readonly (AbortSignal | undefined)[],
): Promise<T> {
	const activeSignals = signals.filter((signal): signal is AbortSignal => Boolean(signal))
	for (const signal of activeSignals) {
		if (signal.aborted) throw abortReason(signal)
	}
	if (activeSignals.length === 0) return task
	let rejectAbort!: (reason: Error) => void
	const aborted = new Promise<never>((_resolve, reject) => {
		rejectAbort = reject
	})
	const listeners = activeSignals.map((signal) => {
		const listener = () => rejectAbort(abortReason(signal))
		signal.addEventListener('abort', listener, { once: true })
		return { signal, listener }
	})
	try {
		return await Promise.race([task, aborted])
	} finally {
		for (const { signal, listener } of listeners) signal.removeEventListener('abort', listener)
	}
}

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error
		? signal.reason
		: new DOMException('Image decode aborted', 'AbortError')
}

function decodeNativeImage(data: Uint8Array): Promise<Image> {
	try {
		return loadNativeImage(Buffer.from(data)).catch((cause: unknown) => {
			throw new CanvasError('INVALID_IMAGE', 'Native image decoder rejected the image data', {
				cause,
			})
		})
	} catch (cause) {
		return Promise.reject(
			new CanvasError('INVALID_IMAGE', 'Native image decoder rejected the image data', { cause }),
		)
	}
}

export {
	CanvasConfig,
	DOMMatrix,
	DOMPoint,
	DOMRect,
	FillType,
	layout,
	layoutNextLine,
	layoutNextLineRange,
	layoutNextRichInlineLineRange,
	layoutWithLines,
	materializeLineRange,
	materializeRichInlineLineRange,
	measureLineStats,
	measureNaturalWidth,
	measureRichInlineStats,
	Path2D,
	PathOp,
	StrokeCap,
	StrokeJoin,
	walkLineRanges,
	walkRichInlineLineRanges,
}
export type {
	Canvas,
	CanvasPluginConfig,
	Image,
	LayoutCursor,
	LayoutLine,
	LayoutLineRange,
	LayoutLinesResult,
	LayoutResult,
	LineStats,
	PreparedRichInline,
	PreparedText,
	PreparedTextWithSegments,
	RichInlineCursor,
	RichInlineFragment,
	RichInlineFragmentRange,
	RichInlineLine,
	RichInlineLineRange,
	RichInlineStats,
	SKRSContext2D,
	SvgCanvas,
}
