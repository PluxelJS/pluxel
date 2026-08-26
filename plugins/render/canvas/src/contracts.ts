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
	/**
	 * `borrowed` snapshots bytes cooperatively before native work; the caller must keep them
	 * unchanged until the Promise settles. `owned` avoids that copy and permanently relinquishes
	 * the supplied storage, which the caller must not read or mutate again, even after rejection.
	 * @defaultValue 'borrowed'
	 */
	dataOwnership?: 'borrowed' | 'owned'
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

/** Detached native-decode admission used by one worker adapter. */
export type CanvasWorkerDecodeLimits = Readonly<{
	maxConcurrent: number
	maxQueued: number
}>

export type CanvasWorkerFontSnapshot = Readonly<{
	/** CSS family list selected by FontsPlugin. */
	cssFamily: string
	/** FontsPlugin revision used to invalidate Pretext measurement caches. */
	revision: number
	/** Concrete selected family that must exist in the native worker registry. Omitted for CSS generic families. */
	requiredFamily?: string
}>

/** Pure-data policy transferred from CanvasPlugin to a worker task. */
export type CanvasWorkerSnapshot = Readonly<{
	limits: CanvasResourceLimits
	textLimits: CanvasTextResourceLimits
	decodeLimits: CanvasWorkerDecodeLimits
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
	/** Whitespace collapsing mode. @defaultValue 'normal' */
	whiteSpace?: 'normal' | 'pre-wrap'
	/** Word-breaking mode. @defaultValue 'normal' */
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
	/** Extra horizontal spacing between graphemes in CSS pixels. @defaultValue 0 */
	letterSpacing?: number
	/** `never` keeps this item atomic during wrapping. @defaultValue 'normal' */
	break?: 'normal' | 'never'
	/** Caller-owned horizontal chrome such as padding and borders. @defaultValue 0 */
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
	| 'DECODE_BUSY'
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

/** Caller-owned native adapter created from one immutable host policy snapshot. */
export interface CanvasWorkerAdapter {
	/** Normalized, nested-frozen policy used by every operation on this adapter. */
	readonly snapshot: CanvasWorkerSnapshot
	/**
	 * Stops accepting new work, rejects queued decodes, and waits for already-submitted native
	 * decodes to settle. Repeated calls are harmless; previously returned native surfaces remain
	 * caller-owned.
	 */
	close(): Promise<void>
	/** Creates a caller-owned native surface after checking its initial allocation budget. */
	createCanvas(width: number, height: number): Canvas
	/** Creates a caller-owned native SVG surface after checking its initial allocation budget. */
	createSvgCanvas(width: number, height: number, options?: SvgCanvasOptions): SvgCanvas
	/** Creates an unbudgeted native placeholder for trusted synchronous platform adapters. */
	createImage(): Image
	/**
	 * Decodes bounded bytes exactly once into a trusted placeholder and returns that same image.
	 * The caller must not reuse or mutate the placeholder until the Promise settles.
	 */
	decodeImageInto(image: Image, data: Uint8Array, options?: DecodeImageOptions): Promise<Image>
	/** Decodes borrowed bytes by default; `dataOwnership: 'owned'` explicitly trades ownership for zero-copy input. */
	decodeImage(data: Uint8Array, options?: DecodeImageOptions): Promise<Image>
}

/** Bounded Pretext preparation bound to one immutable host policy snapshot. */
export interface CanvasWorkerTextLayout {
	/** Normalized, nested-frozen policy used by every preparation on this adapter. */
	readonly snapshot: CanvasWorkerSnapshot
	prepareText(input: PrepareTextInput): PreparedText
	prepareTextWithSegments(input: PrepareTextInput): PreparedTextWithSegments
	prepareRichInline(items: readonly CanvasRichInlineItem[]): PreparedRichInline
}
