import { FontsPlugin, type DefaultFontSnapshot, type PortableFontsSnapshot } from '@pluxel/fonts'
import { FontsSelectionPort } from '@pluxel/fonts/workbench'
import { BasePlugin, Plugin, type Context } from '@pluxel/runtime'
import { workbench } from '@pluxel/runtime/workbench'
import { workbenchContract } from '@pluxel/runtime/workbench/contract'
import { prepareImages } from 'takumi-js/helpers'
import { fromHtml } from 'takumi-js/helpers/html'
import { Renderer, type Node as TakumiNode, type RgbaImage } from 'takumi-js/node'
import { TakumiConfig, type TakumiPluginConfig } from './config.ts'
import { TakumiError, type TakumiErrorCode } from './errors.ts'
import { RenderScheduler, type RenderSchedulerOwner } from './render-scheduler.ts'

const MAX_CONTENT_DEPTH = 256
const MAX_IMAGE_SOURCE_LENGTH = 4_096

const TakumiWorkbench = workbench.portOutlet({
	id: 'Fonts',
	port: FontsSelectionPort,
	placement: workbenchContract.tab({
		label: 'Fonts',
		icon: workbenchContract.icons.Typography,
	}),
})

export type TakumiContent = string | TakumiNode

export type TakumiImageInput = Readonly<{
	/** Exact `src` used by the Takumi node tree. Remote URLs are never fetched implicitly. */
	src: string
	/** Borrowed bytes copied before queue admission. */
	data: Uint8Array
}>

export type TakumiRasterOutput =
	| Readonly<{
			/** @defaultValue 'png' */
			format?: 'png'
			quality?: never
			lossless?: never
	  }>
	| Readonly<{
			format: 'jpeg'
			/** Encoder quality from 0 through 100. */
			quality?: number
			lossless?: never
	  }>
	| Readonly<{
			format: 'webp'
			/** Encoder quality from 0 through 100. */
			quality?: number
			/** Lossless encoding takes precedence over quality. */
			lossless?: boolean
	  }>

export type TakumiRenderInput = Readonly<{
	/** HTML markup or an already-normalized Takumi node tree. */
	content: TakumiContent
	width: number
	height: number
	/** Uses the Plugin config default when omitted. */
	devicePixelRatio?: number
	/** Additional CSS applied after stylesheets extracted from HTML. */
	stylesheets?: readonly string[]
	/** Preloaded encoded sources. Every remote URL referenced by content must have a matching entry. */
	images?: readonly TakumiImageInput[]
	/** Omission produces PNG. */
	output?: TakumiRasterOutput
	/** Cancels queue waiting and Takumi's native render task. Shared font preparation is checkpointed. */
	signal?: AbortSignal
}>

export type TakumiSvgRenderInput = Omit<TakumiRenderInput, 'output' | 'devicePixelRatio'>

export type TakumiRenderResult = Readonly<{
	/** Caller-owned encoded bytes. */
	data: Buffer
	mediaType: 'image/png' | 'image/jpeg' | 'image/webp'
	width: number
	height: number
	devicePixelRatio: number
	/** `FontsPlugin.portableFonts.revision` used by this render. */
	fontRevision: number
}>

export type TakumiSvgRenderResult = Readonly<{
	/** Caller-owned SVG document. */
	data: string
	mediaType: 'image/svg+xml'
	width: number
	height: number
	/** `FontsPlugin.portableFonts.revision` used by this render. */
	fontRevision: number
}>

type TakumiGeneration = Readonly<{
	scheduler: RenderScheduler
	controller: AbortController
	rendererBuilds: Map<number, Promise<PreparedRenderer>>
	state: { renderer?: PreparedRenderer }
}>

type TakumiLease = {
	readonly owner: Context
	readonly generation: TakumiGeneration
	readonly controller: AbortController
	readonly schedulerOwner: RenderSchedulerOwner
	active: boolean
}

type PreparedRenderer = Readonly<{
	revision: number
	renderer: Renderer
	families: readonly string[]
}>

type ContentSnapshot =
	| Readonly<{ kind: 'html'; value: string }>
	| Readonly<{ kind: 'node'; value: TakumiNode }>

type NormalizedImage = Readonly<{ src: string; data: Uint8Array }>

type NormalizedRenderInput = Readonly<{
	content: ContentSnapshot
	width: number
	height: number
	devicePixelRatio: number
	stylesheets: readonly string[]
	images: readonly NormalizedImage[]
	output: Readonly<
		| { format: 'png' }
		| { format: 'jpeg'; quality?: number }
		| { format: 'webp'; quality?: number; lossless?: boolean }
	>
}>

type NodeStats = Readonly<{ nodes: number; textCharacters: number; imageBytes: number }>

@Plugin()
export class TakumiPlugin extends BasePlugin {
	private readonly config = this.configs.use(TakumiConfig)
	private readonly leases = new Set<TakumiLease>()
	private readonly leasesByOwner = new WeakMap<Context, TakumiLease>()
	private generation?: TakumiGeneration

	constructor(private readonly fonts: FontsPlugin) {
		super()
	}

	override init(): void {
		if (this.config.defaultDevicePixelRatio > this.config.maxDevicePixelRatio) {
			throw new TakumiError(
				'INVALID_INPUT',
				'defaultDevicePixelRatio must not exceed maxDevicePixelRatio',
			)
		}
		if (this.config.maxQueuedRendersPerConsumer > this.config.maxQueuedRenders) {
			throw new TakumiError(
				'INVALID_INPUT',
				'maxQueuedRendersPerConsumer must not exceed maxQueuedRenders',
			)
		}
		const generation: TakumiGeneration = Object.freeze({
			scheduler: new RenderScheduler(
				this.config.maxConcurrentRenders,
				this.config.maxQueuedRenders,
				this.config.maxQueuedRendersPerConsumer,
			),
			controller: new AbortController(),
			rendererBuilds: new Map(),
			state: {},
		})
		this.generation = generation
		this.ctx.effects.defer(
			() => {
				if (this.generation === generation) this.generation = undefined
				const reason = new TakumiError(
					'NOT_RUNNING',
					'Takumi capability belongs to a stopped plugin generation',
				)
				generation.controller.abort(reason)
				for (const lease of this.leases) this.closeLease(lease, reason)
				generation.scheduler.close(reason)
				generation.rendererBuilds.clear()
				generation.state.renderer = undefined
			},
			{ tag: 'takumi-generation' },
		)
		this.ctx.workbench?.mount(TakumiWorkbench, {
			selection: workbench.bind.rpc(() => this.fonts.selectionManager('portable')),
		})
	}

	/** Current provider-wide font selection used to order Takumi fallbacks. */
	get defaultFont(): DefaultFontSnapshot {
		this.requireLease()
		return this.fonts.defaultFont
	}

	/** Renders bounded HTML or a Takumi node tree to PNG, JPEG or WebP. */
	async render(input: TakumiRenderInput): Promise<TakumiRenderResult> {
		const lease = this.requireLease()
		const normalized = this.normalizeRenderInput(input)
		const deadline = createRenderDeadline(this.config.maxRenderDurationMs)
		const abortLink = linkAbortSignals([lease.controller.signal, input.signal, deadline.signal])
		try {
			return await lease.generation.scheduler.run(
				lease.schedulerOwner,
				abortLink.signal,
				async () => this.executeRaster(normalized, abortLink.signal, lease.generation),
			)
		} catch (cause) {
			if (cause instanceof TakumiError) throw cause
			if (abortLink.signal.aborted) throw abortReason(abortLink.signal)
			throw new TakumiError('RENDER_FAILED', 'Takumi raster rendering failed', { cause })
		} finally {
			abortLink.dispose()
			deadline.dispose()
		}
	}

	/** Renders bounded HTML or a Takumi node tree to a vector SVG document. */
	async renderSvg(input: TakumiSvgRenderInput): Promise<TakumiSvgRenderResult> {
		const lease = this.requireLease()
		const normalized = this.normalizeRenderInput({ ...input, devicePixelRatio: 1 })
		const deadline = createRenderDeadline(this.config.maxRenderDurationMs)
		const abortLink = linkAbortSignals([lease.controller.signal, input.signal, deadline.signal])
		try {
			return await lease.generation.scheduler.run(
				lease.schedulerOwner,
				abortLink.signal,
				async () => this.executeSvg(normalized, abortLink.signal, lease.generation),
			)
		} catch (cause) {
			if (cause instanceof TakumiError) throw cause
			if (abortLink.signal.aborted) throw abortReason(abortLink.signal)
			throw new TakumiError('RENDER_FAILED', 'Takumi SVG rendering failed', { cause })
		} finally {
			abortLink.dispose()
			deadline.dispose()
		}
	}

	private async executeRaster(
		input: NormalizedRenderInput,
		signal: AbortSignal,
		generation: TakumiGeneration,
	): Promise<TakumiRenderResult> {
		const prepared = await this.prepare(input, signal, generation)
		let encoded: Uint8Array
		try {
			encoded = await prepared.renderer.renderer.render(prepared.node, {
				width: input.width,
				height: input.height,
				devicePixelRatio: input.devicePixelRatio,
				...input.output,
				stylesheets: [...prepared.stylesheets],
				images: [...prepared.images],
				...(prepared.fontFamilies ? { fontFamilies: prepared.fontFamilies } : {}),
				signal,
			})
		} catch (cause) {
			if (signal.aborted) throw abortReason(signal)
			throw new TakumiError('RENDER_FAILED', 'Takumi native raster rendering failed', { cause })
		}
		this.assertOutputBytes(encoded.byteLength)
		return Object.freeze({
			data: bufferView(encoded),
			mediaType: mediaTypeFor(input.output.format),
			width: input.width,
			height: input.height,
			devicePixelRatio: input.devicePixelRatio,
			fontRevision: prepared.renderer.revision,
		})
	}

	private async executeSvg(
		input: NormalizedRenderInput,
		signal: AbortSignal,
		generation: TakumiGeneration,
	): Promise<TakumiSvgRenderResult> {
		const prepared = await this.prepare(input, signal, generation)
		let data: string
		try {
			data = await prepared.renderer.renderer.renderSvg(prepared.node, {
				width: input.width,
				height: input.height,
				stylesheets: [...prepared.stylesheets],
				images: [...prepared.images],
				...(prepared.fontFamilies ? { fontFamilies: prepared.fontFamilies } : {}),
				signal,
			})
		} catch (cause) {
			if (signal.aborted) throw abortReason(signal)
			throw new TakumiError('RENDER_FAILED', 'Takumi native SVG rendering failed', { cause })
		}
		this.assertOutputBytes(Buffer.byteLength(data, 'utf8'))
		return Object.freeze({
			data,
			mediaType: 'image/svg+xml',
			width: input.width,
			height: input.height,
			fontRevision: prepared.renderer.revision,
		})
	}

	private async prepare(
		input: NormalizedRenderInput,
		signal: AbortSignal,
		generation: TakumiGeneration,
	) {
		signal.throwIfAborted()
		const content =
			input.content.kind === 'html'
				? fromHtml(input.content.value)
				: { node: input.content.value, stylesheets: [] }
		const stats = inspectNode(content.node, {
			maxContentBytes: this.config.maxContentBytes,
			maxContentNodes: this.config.maxContentNodes!,
			maxTextCharacters: this.config.maxTextCharacters!,
		})
		const suppliedImageBytes = input.images.reduce((sum, image) => sum + image.data.byteLength, 0)
		if (stats.imageBytes + suppliedImageBytes > this.config.maxImageBytes) {
			throw new TakumiError(
				'IMAGE_BYTES_EXCEEDED',
				`Render image sources exceed the configured ${this.config.maxImageBytes} byte limit`,
			)
		}
		const stylesheets = Object.freeze([...content.stylesheets, ...input.stylesheets])
		this.assertStylesheetBytes(stylesheets)
		let images: Awaited<ReturnType<typeof prepareImages<NormalizedImage>>>
		try {
			images = await prepareImages<NormalizedImage>({
				node: content.node,
				sources: [...input.images],
				allowUrl: () => false,
				maxBytes: this.config.maxImageBytes,
				signal,
			})
		} catch (cause) {
			if (signal.aborted) throw abortReason(signal)
			throw new TakumiError(
				'INVALID_IMAGE',
				'Every remote image URL must have a matching preloaded images entry',
				{ cause },
			)
		}
		const portableFonts = this.fonts.portableFonts
		const renderer = await this.rendererFor(portableFonts, generation)
		signal.throwIfAborted()
		const defaultFont = this.fonts.defaultFont
		return Object.freeze({
			node: content.node,
			stylesheets,
			images,
			renderer,
			fontFamilies: orderFontFamilies(renderer.families, defaultFont.family),
		})
	}

	private rendererFor(
		snapshot: PortableFontsSnapshot,
		generation: TakumiGeneration,
	): Promise<PreparedRenderer> {
		generation.controller.signal.throwIfAborted()
		if (generation.state.renderer?.revision === snapshot.revision) {
			return Promise.resolve(generation.state.renderer)
		}
		const existing = generation.rendererBuilds.get(snapshot.revision)
		if (existing) return existing
		const totalBytes = snapshot.fonts.reduce((sum, font) => sum + font.byteLength, 0)
		if (totalBytes > this.config.maxFontBytes) {
			return Promise.reject(
				new TakumiError(
					'FONT_BYTES_EXCEEDED',
					`Portable fonts require ${totalBytes} bytes; the configured limit is ${this.config.maxFontBytes}`,
				),
			)
		}
		const resources = snapshot.fonts.map((font) => ({
			font,
			data: this.fonts.readPortableFont(font.id),
		}))
		const build = this.buildRenderer(snapshot.revision, resources, generation.controller.signal)
		generation.rendererBuilds.set(snapshot.revision, build)
		void build.then(
			(state): undefined => {
				generation.rendererBuilds.delete(snapshot.revision)
				if (
					!generation.controller.signal.aborted &&
					(!generation.state.renderer || state.revision >= generation.state.renderer.revision)
				) {
					generation.state.renderer = state
				}
				return undefined
			},
			(): undefined => {
				generation.rendererBuilds.delete(snapshot.revision)
				return undefined
			},
		)
		return build
	}

	private async buildRenderer(
		revision: number,
		resources: readonly Readonly<{
			font: PortableFontsSnapshot['fonts'][number]
			data: Uint8Array
		}>[],
		signal: AbortSignal,
	): Promise<PreparedRenderer> {
		const renderer = new Renderer({ cacheMaxBytes: this.config.cacheMaxBytes })
		const families: string[] = []
		try {
			for (const { font, data } of resources) {
				signal.throwIfAborted()
				const registered = await renderer.registerFont(
					font.family ? { name: font.family, data } : data,
				)
				for (const family of registered) {
					if (!families.includes(family.name)) families.push(family.name)
				}
			}
			signal.throwIfAborted()
		} catch (cause) {
			if (signal.aborted) throw abortReason(signal)
			throw new TakumiError('FONT_LOAD_FAILED', 'Takumi rejected a portable font resource', {
				cause,
			})
		}
		return Object.freeze({ revision, renderer, families: Object.freeze(families) })
	}

	private normalizeRenderInput(input: TakumiRenderInput): NormalizedRenderInput {
		if (!input || typeof input !== 'object' || Array.isArray(input)) {
			throw new TakumiError('INVALID_INPUT', 'Takumi render input must be an object')
		}
		if (input.signal !== undefined && !isAbortSignal(input.signal)) {
			throw new TakumiError('INVALID_INPUT', 'signal must be an AbortSignal')
		}
		if (!Number.isSafeInteger(input.width) || !Number.isSafeInteger(input.height)) {
			throw new TakumiError('INVALID_INPUT', 'Render width and height must be integers')
		}
		if (input.width <= 0 || input.height <= 0) {
			throw new TakumiError('INVALID_INPUT', 'Render width and height must be positive')
		}
		const devicePixelRatio = input.devicePixelRatio ?? this.config.defaultDevicePixelRatio
		if (
			!Number.isFinite(devicePixelRatio) ||
			devicePixelRatio <= 0 ||
			devicePixelRatio > this.config.maxDevicePixelRatio
		) {
			throw new TakumiError(
				'INVALID_INPUT',
				`devicePixelRatio must be greater than 0 and at most ${this.config.maxDevicePixelRatio}`,
			)
		}
		const physicalWidth = Math.ceil(input.width * devicePixelRatio)
		const physicalHeight = Math.ceil(input.height * devicePixelRatio)
		if (physicalWidth > this.config.maxWidth || physicalHeight > this.config.maxHeight) {
			throw new TakumiError(
				'DIMENSIONS_EXCEEDED',
				`Physical dimensions ${physicalWidth}×${physicalHeight} exceed the configured ${this.config.maxWidth}×${this.config.maxHeight} limit`,
			)
		}
		if (physicalWidth * physicalHeight > this.config.maxPixels) {
			throw new TakumiError(
				'PIXELS_EXCEEDED',
				`Physical dimensions require ${physicalWidth * physicalHeight} pixels; the configured limit is ${this.config.maxPixels}`,
			)
		}
		const content = snapshotContent(input.content, this.config.maxContentBytes)
		if (content.kind === 'node') {
			inspectNode(content.value, {
				maxContentBytes: this.config.maxContentBytes,
				maxContentNodes: this.config.maxContentNodes!,
				maxTextCharacters: this.config.maxTextCharacters!,
			})
		}
		const stylesheets = normalizeStylesheets(input.stylesheets)
		this.assertStylesheetBytes(stylesheets)
		const images = normalizeImages(input.images, this.config.maxImageBytes)
		const output = normalizeOutput('output' in input ? input.output : undefined)
		return Object.freeze({
			content,
			width: input.width,
			height: input.height,
			devicePixelRatio,
			stylesheets,
			images,
			output,
		})
	}

	private assertStylesheetBytes(stylesheets: readonly string[]): void {
		const byteLength = stylesheets.reduce(
			(sum, stylesheet) => sum + Buffer.byteLength(stylesheet, 'utf8'),
			0,
		)
		if (byteLength > this.config.maxStylesheetBytes) {
			throw new TakumiError(
				'STYLESHEET_TOO_LARGE',
				`Stylesheets require ${byteLength} bytes; the configured limit is ${this.config.maxStylesheetBytes}`,
			)
		}
	}

	private assertOutputBytes(byteLength: number): void {
		if (byteLength > this.config.maxOutputBytes) {
			throw new TakumiError(
				'OUTPUT_TOO_LARGE',
				`Takumi output is ${byteLength} bytes; the configured limit is ${this.config.maxOutputBytes}`,
			)
		}
	}

	private requireLease(): TakumiLease {
		const generation = this.generation
		if (!generation) throw new TakumiError('NOT_RUNNING', 'TakumiPlugin is not running')
		const owner = this.ctx.caller ?? this.ctx
		const existing = this.leasesByOwner.get(owner)
		if (existing) {
			if (!existing.active || existing.generation !== generation) {
				throw new TakumiError(
					'NOT_RUNNING',
					'Takumi capability belongs to a stopped plugin generation',
				)
			}
			return existing
		}
		const lease: TakumiLease = {
			owner,
			generation,
			controller: new AbortController(),
			schedulerOwner: generation.scheduler.createOwner(),
			active: true,
		}
		this.leases.add(lease)
		this.leasesByOwner.set(owner, lease)
		try {
			owner.effects.defer(() => this.closeLease(lease), { tag: 'takumi-caller' })
		} catch (cause) {
			this.closeLease(lease)
			throw new TakumiError('NOT_RUNNING', 'Takumi caller is stopped or being replaced', {
				cause,
			})
		}
		return lease
	}

	private closeLease(lease: TakumiLease, reason?: Error): void {
		if (!lease.active) return
		lease.active = false
		const stopped =
			reason ??
			new TakumiError('NOT_RUNNING', 'Takumi capability belongs to a stopped caller generation')
		lease.controller.abort(stopped)
		lease.generation.scheduler.closeOwner(lease.schedulerOwner, stopped)
		this.leases.delete(lease)
		if (this.leasesByOwner.get(lease.owner) === lease) this.leasesByOwner.delete(lease.owner)
	}
}

function snapshotContent(content: unknown, maxContentBytes: number): ContentSnapshot {
	if (typeof content === 'string') {
		const byteLength = Buffer.byteLength(content, 'utf8')
		if (byteLength > maxContentBytes) {
			throw new TakumiError(
				'CONTENT_TOO_LARGE',
				`HTML content is ${byteLength} bytes; the configured limit is ${maxContentBytes}`,
			)
		}
		return Object.freeze({ kind: 'html', value: content })
	}
	try {
		return Object.freeze({ kind: 'node', value: structuredClone(content) as TakumiNode })
	} catch (cause) {
		throw new TakumiError(
			'INVALID_INPUT',
			'content must be HTML text or a structured-clone-compatible Takumi node tree',
			{ cause },
		)
	}
}

function inspectNode(
	root: TakumiNode,
	limits: Readonly<{
		maxContentBytes: number
		maxContentNodes: number
		maxTextCharacters: number
	}>,
): NodeStats {
	assertStructuredContentBytes(root, limits.maxContentBytes)
	const stack: Array<Readonly<{ value: unknown; depth: number }>> = [{ value: root, depth: 0 }]
	const seen = new WeakSet<object>()
	let nodes = 0
	let textCharacters = 0
	let imageBytes = 0
	while (stack.length > 0) {
		const current = stack.pop()!
		if (current.depth > MAX_CONTENT_DEPTH) {
			throw new TakumiError(
				'CONTENT_TOO_LARGE',
				`Takumi node nesting exceeds ${MAX_CONTENT_DEPTH} levels`,
			)
		}
		if (!isRecord(current.value)) {
			throw new TakumiError('INVALID_INPUT', 'Takumi content contains a non-object node')
		}
		if (seen.has(current.value)) {
			throw new TakumiError('INVALID_INPUT', 'Takumi content must not contain node cycles')
		}
		seen.add(current.value)
		nodes += 1
		if (nodes > limits.maxContentNodes) {
			throw new TakumiError(
				'CONTENT_TOO_LARGE',
				`Takumi content exceeds the configured ${limits.maxContentNodes} node limit`,
			)
		}
		if (current.value.type === 'container') {
			const children = current.value.children
			if (children === undefined) continue
			if (!Array.isArray(children)) {
				throw new TakumiError('INVALID_INPUT', 'Takumi container children must be an array')
			}
			for (let index = children.length - 1; index >= 0; index -= 1) {
				stack.push({ value: children[index], depth: current.depth + 1 })
			}
			continue
		}
		if (current.value.type === 'text') {
			if (typeof current.value.text !== 'string') {
				throw new TakumiError('INVALID_INPUT', 'Takumi text nodes require string text')
			}
			textCharacters += current.value.text.length
			if (textCharacters > limits.maxTextCharacters) {
				throw new TakumiError(
					'CONTENT_TOO_LARGE',
					`Takumi text exceeds the configured ${limits.maxTextCharacters} character limit`,
				)
			}
			continue
		}
		if (current.value.type === 'image') {
			imageBytes += imageSourceBytes(current.value.src)
			continue
		}
		throw new TakumiError('INVALID_INPUT', 'Takumi node type must be container, text or image')
	}
	return Object.freeze({ nodes, textCharacters, imageBytes })
}

function assertStructuredContentBytes(root: unknown, maxBytes: number): void {
	const stack: unknown[] = [root]
	const seen = new WeakSet<object>()
	let byteLength = 0
	const add = (bytes: number) => {
		byteLength += bytes
		if (byteLength > maxBytes) {
			throw new TakumiError(
				'CONTENT_TOO_LARGE',
				`Structured content exceeds the configured ${maxBytes} byte limit`,
			)
		}
	}
	while (stack.length > 0) {
		const value = stack.pop()
		if (typeof value === 'string') {
			add(Buffer.byteLength(value, 'utf8'))
			continue
		}
		if (
			value === null ||
			value === undefined ||
			typeof value === 'symbol' ||
			typeof value === 'function'
		) {
			continue
		}
		if (typeof value !== 'object') {
			add(8)
			continue
		}
		if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) continue
		if (seen.has(value)) continue
		seen.add(value)
		if (Array.isArray(value)) {
			add(value.length * 4)
			for (const item of value) stack.push(item)
			continue
		}
		for (const [key, item] of Object.entries(value)) {
			add(Buffer.byteLength(key, 'utf8') + 4)
			stack.push(item)
		}
	}
}

function imageSourceBytes(value: unknown): number {
	if (typeof value === 'string') return 0
	if (value instanceof Uint8Array) {
		assertUnsharedBytes(value)
		return value.byteLength
	}
	if (value instanceof ArrayBuffer) return value.byteLength
	if (!isRecord(value)) {
		throw new TakumiError('INVALID_IMAGE', 'Takumi image source is invalid')
	}
	const rgba = value as RgbaImage
	if (
		!Number.isSafeInteger(rgba.width) ||
		!Number.isSafeInteger(rgba.height) ||
		rgba.width <= 0 ||
		rgba.height <= 0 ||
		!(rgba.data instanceof Uint8Array || rgba.data instanceof ArrayBuffer)
	) {
		throw new TakumiError('INVALID_IMAGE', 'Takumi RGBA image source is invalid')
	}
	const required = rgba.width * rgba.height * 4
	if (!Number.isSafeInteger(required) || rgba.data.byteLength !== required) {
		throw new TakumiError('INVALID_IMAGE', 'Takumi RGBA image byte length is invalid')
	}
	if (rgba.data instanceof Uint8Array) assertUnsharedBytes(rgba.data)
	return required
}

function assertUnsharedBytes(value: Uint8Array): void {
	if (value.buffer instanceof SharedArrayBuffer) {
		throw new TakumiError('INVALID_IMAGE', 'Takumi node image bytes must not use shared memory')
	}
}

function normalizeStylesheets(value: unknown): readonly string[] {
	if (value === undefined) return Object.freeze([])
	if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
		throw new TakumiError('INVALID_INPUT', 'stylesheets must be an array of strings')
	}
	return Object.freeze([...value])
}

function normalizeImages(value: unknown, maxBytes: number): readonly NormalizedImage[] {
	if (value === undefined) return Object.freeze([])
	if (!Array.isArray(value)) {
		throw new TakumiError('INVALID_IMAGE', 'images must be an array')
	}
	const seen = new Set<string>()
	const images: NormalizedImage[] = []
	let totalBytes = 0
	for (const item of value) {
		if (!isRecord(item) || typeof item.src !== 'string' || !(item.data instanceof Uint8Array)) {
			throw new TakumiError(
				'INVALID_IMAGE',
				'Every image requires a string src and Uint8Array data',
			)
		}
		const src = item.src
		if (
			!src ||
			src !== src.trim() ||
			src.length > MAX_IMAGE_SOURCE_LENGTH ||
			hasControlCharacters(src) ||
			item.data.byteLength <= 0
		) {
			throw new TakumiError('INVALID_IMAGE', 'Image src or data is empty or invalid')
		}
		if (seen.has(src)) throw new TakumiError('INVALID_IMAGE', `Duplicate image src: ${src}`)
		seen.add(src)
		totalBytes += item.data.byteLength
		if (totalBytes > maxBytes) {
			throw new TakumiError(
				'IMAGE_BYTES_EXCEEDED',
				`Preloaded images exceed the configured ${maxBytes} byte limit`,
			)
		}
		images.push(Object.freeze({ src, data: Uint8Array.from(item.data) }))
	}
	return Object.freeze(images)
}

function normalizeOutput(output: TakumiRasterOutput | undefined): NormalizedRenderInput['output'] {
	if (output !== undefined && (!output || typeof output !== 'object' || Array.isArray(output))) {
		throw new TakumiError('INVALID_INPUT', 'output must be an object')
	}
	const format = output?.format ?? 'png'
	if (format !== 'png' && format !== 'jpeg' && format !== 'webp') {
		throw new TakumiError('INVALID_INPUT', 'Output format must be png, jpeg or webp')
	}
	if (format === 'png') {
		if (
			output &&
			(('quality' in output && output.quality !== undefined) ||
				('lossless' in output && output.lossless !== undefined))
		) {
			throw new TakumiError('INVALID_INPUT', 'PNG output does not accept quality or lossless')
		}
		return Object.freeze({ format })
	}
	const quality = output?.quality
	if (quality !== undefined && (!Number.isFinite(quality) || quality < 0 || quality > 100)) {
		throw new TakumiError('INVALID_INPUT', 'Output quality must be between 0 and 100')
	}
	if (format === 'jpeg') {
		if (output && 'lossless' in output && output.lossless !== undefined) {
			throw new TakumiError('INVALID_INPUT', 'JPEG output does not accept lossless')
		}
		return Object.freeze({ format, ...(quality === undefined ? {} : { quality }) })
	}
	const lossless = output && 'lossless' in output ? output.lossless : undefined
	if (lossless !== undefined && typeof lossless !== 'boolean') {
		throw new TakumiError('INVALID_INPUT', 'WebP lossless must be boolean')
	}
	return Object.freeze({
		format,
		...(quality === undefined ? {} : { quality }),
		...(lossless === undefined ? {} : { lossless }),
	})
}

function orderFontFamilies(
	families: readonly string[],
	defaultFamily: string,
): string[] | undefined {
	if (families.length === 0) return undefined
	const defaultKey = defaultFamily.toLocaleLowerCase('en-US')
	const selected = families.find((family) => family.toLocaleLowerCase('en-US') === defaultKey)
	return selected ? [selected, ...families.filter((family) => family !== selected)] : [...families]
}

function mediaTypeFor(format: 'png' | 'jpeg' | 'webp'): TakumiRenderResult['mediaType'] {
	return format === 'png' ? 'image/png' : format === 'jpeg' ? 'image/jpeg' : 'image/webp'
}

function bufferView(data: Uint8Array): Buffer {
	if (Buffer.isBuffer(data)) return data
	return data.buffer instanceof ArrayBuffer
		? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
		: Buffer.from(data)
}

function linkAbortSignals(signals: readonly (AbortSignal | undefined)[]): Readonly<{
	signal: AbortSignal
	dispose(): void
}> {
	const controller = new AbortController()
	const listeners: Array<Readonly<{ signal: AbortSignal; listener: () => void }>> = []
	for (const signal of signals) {
		if (!signal) continue
		if (signal.aborted) {
			controller.abort(signal.reason)
			break
		}
		const listener = () => controller.abort(signal.reason)
		signal.addEventListener('abort', listener, { once: true })
		listeners.push({ signal, listener })
	}
	return Object.freeze({
		signal: controller.signal,
		dispose() {
			for (const { signal, listener } of listeners) signal.removeEventListener('abort', listener)
		},
	})
}

function createRenderDeadline(durationMs: number): Readonly<{
	signal: AbortSignal
	dispose(): void
}> {
	const controller = new AbortController()
	const timer = setTimeout(() => {
		controller.abort(
			new TakumiError(
				'RENDER_TIMEOUT',
				`Takumi render exceeded the configured ${durationMs}ms deadline`,
			),
		)
	}, durationMs)
	timer.unref()
	return Object.freeze({
		signal: controller.signal,
		dispose: () => clearTimeout(timer),
	})
}

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error
		? signal.reason
		: new DOMException('Takumi rendering aborted', 'AbortError')
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isAbortSignal(value: unknown): value is AbortSignal {
	return (
		isRecord(value) &&
		typeof value.aborted === 'boolean' &&
		typeof value.addEventListener === 'function' &&
		typeof value.removeEventListener === 'function'
	)
}

function hasControlCharacters(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index)
		if (code <= 0x1f || code === 0x7f) return true
	}
	return false
}

export { TakumiConfig, TakumiError }
export type { TakumiErrorCode, TakumiNode, TakumiPluginConfig }
