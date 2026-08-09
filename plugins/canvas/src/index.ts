import {
	layout,
	layoutNextLine,
	layoutNextLineRange,
	layoutWithLines,
	materializeLineRange,
	measureLineStats,
	measureNaturalWidth,
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
import {
	CanvasError,
	type CanvasErrorCode,
	type CanvasResourceLimits,
	type CanvasRichInlineItem,
	type CanvasTextFontInput,
	type CanvasTextPreparationOptions,
	type CanvasTextResourceLimits,
	type CanvasWorkerAdapter,
	type CanvasWorkerFontSnapshot,
	type CanvasWorkerSnapshot,
	type CanvasWorkerTextLayout,
	type DecodeImageOptions,
	type PrepareTextInput,
	type SvgCanvasOptions,
} from './contracts.ts'
import { CanvasTextLayoutController } from './text-layout.ts'
import { assertCanvasDimensions, resolveImageDataOwnership } from './worker-internal.ts'

const GENERIC_FONT_FAMILIES = new Set(['serif', 'sans-serif', 'monospace'])

const CanvasWorkbench = workbench.portOutlet({
	id: 'Fonts',
	port: FontsSelectionPort,
	placement: workbenchContract.tab({
		label: 'Fonts',
		icon: workbenchContract.icons.Typography,
	}),
})

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
	private readonly textLayout = new CanvasTextLayoutController()
	private limitsSnapshot?: CanvasResourceLimits
	private textLimitsSnapshot?: CanvasTextResourceLimits
	private workerPolicy?: Readonly<{ revision: number; snapshot: CanvasWorkerSnapshot }>
	private generation?: object

	constructor(private readonly fonts: FontsPlugin) {
		super()
	}

	override async init(): Promise<void> {
		const generation = Object.freeze({})
		this.limitsSnapshot = Object.freeze({
			maxWidth: this.config.maxWidth,
			maxHeight: this.config.maxHeight,
			maxPixels: this.config.maxPixels,
			maxImageBytes: this.config.maxImageBytes,
		})
		this.textLimitsSnapshot = Object.freeze({
			maxTextCharacters: this.config.maxTextCharacters,
			maxRichTextItems: this.config.maxRichTextItems,
			maxTextCacheCharacters: this.config.maxTextCacheCharacters,
		})
		this.workerPolicy = undefined
		this.generation = generation
		this.ctx.effects.defer(
			() => {
				if (this.generation === generation) {
					this.generation = undefined
					this.limitsSnapshot = undefined
					this.textLimitsSnapshot = undefined
				}
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

	/** Current host ceilings for adapters that must recreate native Canvas resources off-thread. */
	get limits(): CanvasResourceLimits {
		this.requireLease()
		return this.resourceLimits()
	}

	/** Detached native/text/font policy for `@pluxel/canvas/worker` adapters. */
	get workerSnapshot(): CanvasWorkerSnapshot {
		this.requireLease()
		const revision = this.fonts.revision
		if (this.workerPolicy?.revision === revision) return this.workerPolicy.snapshot
		const defaultFont = this.fonts.defaultFont
		const requiredFamily = GENERIC_FONT_FAMILIES.has(defaultFont.family.toLowerCase())
			? undefined
			: defaultFont.family
		const snapshot = Object.freeze({
			limits: this.resourceLimits(),
			textLimits: this.textResourceLimits(),
			font: Object.freeze({
				cssFamily: defaultFont.cssFamily,
				revision,
				...(requiredFamily === undefined ? {} : { requiredFamily }),
			}),
		})
		this.workerPolicy = Object.freeze({ revision, snapshot })
		return snapshot
	}

	/**
	 * Creates a native raster Canvas after enforcing the host's initial allocation budget.
	 * The returned native object is caller-owned and may be resized independently afterwards.
	 */
	createCanvas(width: number, height: number): Canvas {
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
		const dataOwnership = resolveImageDataOwnership(options)
		if (options.signal?.aborted) throw abortReason(options.signal)
		const source = dataOwnership === 'owned' ? data : Buffer.from(data)
		const task = decodeNativeImage(source)
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
		return this.textLayout.prepareText(input, this.workerSnapshot)
	}

	/** Prepares the richer Pretext representation required for manual Canvas line rendering. */
	prepareTextWithSegments(input: PrepareTextInput): PreparedTextWithSegments {
		return this.textLayout.prepareTextWithSegments(input, this.workerSnapshot)
	}

	/** Prepares inline fragments while applying the Pluxel default family to items without `font`. */
	prepareRichInline(items: readonly CanvasRichInlineItem[]): PreparedRichInline {
		return this.textLayout.prepareRichInline(items, this.workerSnapshot)
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

	/** Validate dimensions without allocating a native surface. */
	assertDimensions(width: number, height: number): void {
		this.requireLease()
		assertCanvasDimensions(width, height, this.resourceLimits())
	}

	private applyDefaultFont(canvas: Canvas | SvgCanvas): void {
		canvas.getContext('2d').font = `10px ${this.fonts.defaultFont.cssFamily}`
	}

	private resourceLimits(): CanvasResourceLimits {
		if (!this.limitsSnapshot) throw new CanvasError('NOT_RUNNING', 'CanvasPlugin is not running')
		return this.limitsSnapshot
	}

	private textResourceLimits(): CanvasTextResourceLimits {
		if (!this.textLimitsSnapshot) {
			throw new CanvasError('NOT_RUNNING', 'CanvasPlugin is not running')
		}
		return this.textLimitsSnapshot
	}
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
		return loadNativeImage(data).catch((cause: unknown) => {
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
	CanvasError,
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
	CanvasErrorCode,
	CanvasPluginConfig,
	CanvasResourceLimits,
	CanvasRichInlineItem,
	CanvasTextFontInput,
	CanvasTextPreparationOptions,
	CanvasTextResourceLimits,
	CanvasWorkerAdapter,
	CanvasWorkerFontSnapshot,
	CanvasWorkerSnapshot,
	CanvasWorkerTextLayout,
	DecodeImageOptions,
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
	PrepareTextInput,
	RichInlineCursor,
	RichInlineFragment,
	RichInlineFragmentRange,
	RichInlineLine,
	RichInlineLineRange,
	RichInlineStats,
	SKRSContext2D,
	SvgCanvasOptions,
	SvgCanvas,
}
