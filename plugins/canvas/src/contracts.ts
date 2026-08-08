import type { PreparedText, PreparedTextWithSegments } from '@chenglou/pretext'
import type { PreparedRichInline } from '@chenglou/pretext/rich-inline'
import type { Canvas, Image, SvgCanvas } from '@napi-rs/canvas'

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

/** Detached host ceilings suitable for validating native allocations in a worker task. */
export type CanvasResourceLimits = Readonly<{
	maxWidth: number
	maxHeight: number
	maxPixels: number
	maxImageBytes: number
}>

/** Detached host ceilings for Pretext work and its thread-local measurement cache. */
export type CanvasTextResourceLimits = Readonly<{
	maxTextCharacters: number
	maxRichTextItems: number
	maxTextCacheCharacters: number
}>

export type CanvasWorkerFontSnapshot = Readonly<{
	/** CSS family list selected by FontsPlugin. */
	cssFamily: string
	/** FontsPlugin revision used to invalidate Pretext measurement caches. */
	revision: number
	/** Concrete selected family that must exist in the native worker registry. */
	requiredFamily?: string
}>

/** Pure-data policy transferred from CanvasPlugin to a worker task. */
export type CanvasWorkerSnapshot = Readonly<{
	limits: CanvasResourceLimits
	textLimits: CanvasTextResourceLimits
	font: CanvasWorkerFontSnapshot
}>

export type CanvasTextFontInput =
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

export type CanvasTextPreparationOptions = Readonly<{
	whiteSpace?: 'normal' | 'pre-wrap'
	wordBreak?: 'normal' | 'keep-all'
	/** CSS pixel value matching the eventual renderer. @defaultValue 0 */
	letterSpacing?: number
}>

export type PrepareTextInput = Readonly<{
	text: string
}> &
	CanvasTextFontInput &
	CanvasTextPreparationOptions

export type CanvasRichInlineItem = Readonly<{
	text: string
	letterSpacing?: number
	break?: 'normal' | 'never'
	extraWidth?: number
}> &
	CanvasTextFontInput

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
	| 'FONT_UNAVAILABLE'
	| 'INVALID_WORKER_SNAPSHOT'

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

/** Thread-local native adapter created from one immutable host policy snapshot. */
export interface CanvasWorkerAdapter {
	readonly snapshot: CanvasWorkerSnapshot
	createCanvas(width: number, height: number): Canvas
	createSvgCanvas(width: number, height: number, options?: SvgCanvasOptions): SvgCanvas
	createImage(): Image
	decodeImage(data: Uint8Array, options?: DecodeImageOptions): Promise<Image>
}

/** Bounded Pretext preparation bound to one immutable host policy snapshot. */
export interface CanvasWorkerTextLayout {
	readonly snapshot: CanvasWorkerSnapshot
	prepareText(input: PrepareTextInput): PreparedText
	prepareTextWithSegments(input: PrepareTextInput): PreparedTextWithSegments
	prepareRichInline(items: readonly CanvasRichInlineItem[]): PreparedRichInline
}
