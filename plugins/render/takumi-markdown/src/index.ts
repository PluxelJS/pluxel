import { BasePlugin, Plugin, type Context } from '@pluxel/runtime'
import {
	TakumiError,
	TakumiPlugin,
	type TakumiImageInput,
	type TakumiRasterOutput,
	type TakumiRenderLimits,
	type TakumiRenderReservation,
	type TakumiRenderResult,
	type TakumiSvgRenderResult,
} from '@pluxel/takumi'
import { codeToHtml } from 'rangi'
import {
	defineHastPlugin,
	defineMdastPlugin,
	htmlToHast,
	markdownToHtml,
	type Features,
	type HastPluginEntry,
	type MdastPluginEntry,
} from 'satteri'
import {
	createMarkdownRenderLimits,
	TakumiMarkdownConfig,
	type MarkdownRenderLimits,
	type TakumiMarkdownPluginConfig,
} from './config.ts'
import { MarkdownError, type MarkdownErrorCode } from './errors.ts'
import { MARKDOWN_STYLESHEET } from './styles.ts'

const INTERNAL_ASSET_PREFIX = 'pluxel://markdown-internal/'
const UTF8_CHUNK_CHARACTERS = 64 * 1024
const MAX_EXTENSION_NAME_LENGTH = 128

export type MarkdownTheme = 'light' | 'dark'

export type MarkdownAssetMediaType = 'image/svg+xml' | 'image/png' | 'image/jpeg' | 'image/webp'

export type MarkdownAssetInput = Readonly<{
	/** Bytes are copied while the accepted render remains active. */
	data: Uint8Array
	mediaType: MarkdownAssetMediaType
}>

export type MarkdownAssetSink = Readonly<{
	/**
	 * Adds a generated image under an opaque internal source. Extensions cannot choose a URL,
	 * fetch a resource, or retain the sink after this render settles.
	 */
	add(input: MarkdownAssetInput): Promise<string>
}>

export type MarkdownExtensionFeatures = Readonly<
	Pick<
		Features,
		| 'math'
		| 'headingAttributes'
		| 'directive'
		| 'superscript'
		| 'subscript'
		| 'wikilinks'
		| 'definitionList'
		| 'smartPunctuation'
	>
>

export type MarkdownExtensionContext = Readonly<{
	source: string
	signal: AbortSignal
	assets: MarkdownAssetSink
	limits: MarkdownRenderLimits
}>

export type MarkdownExtensionPipeline = Readonly<{
	mdast?: readonly MdastPluginEntry[]
	hast?: readonly HastPluginEntry[]
}>

/**
 * Trusted startup-time composition. Extension factories run once for each accepted render,
 * in renderer-array order; raw Markdown HTML remains disabled and is removed after HAST passes.
 */
export type MarkdownExtension = Readonly<{
	name: string
	requiredFeatures?: MarkdownExtensionFeatures
	create(
		context: MarkdownExtensionContext,
	): MarkdownExtensionPipeline | null | Promise<MarkdownExtensionPipeline | null>
}>

export type MarkdownRendererOptions = Readonly<{
	extensions?: readonly MarkdownExtension[]
	/** @defaultValue 'light' */
	theme?: MarkdownTheme
}>

export type MarkdownRenderInput = Readonly<{
	markdown: string
	width: number
	height: number
	/** Uses Takumi's configured default when omitted. */
	devicePixelRatio?: number
	images?: readonly TakumiImageInput[]
	stylesheets?: readonly string[]
	output?: TakumiRasterOutput
	/** Cancels admission, Markdown preparation and the final Takumi render. */
	signal?: AbortSignal
	/** Overrides the renderer default for this document only. */
	theme?: MarkdownTheme
}>

export type MarkdownSvgRenderInput = Omit<MarkdownRenderInput, 'output' | 'devicePixelRatio'>

export type MarkdownRenderer = Readonly<{
	render(input: MarkdownRenderInput): Promise<TakumiRenderResult>
	renderSvg(input: MarkdownSvgRenderInput): Promise<TakumiSvgRenderResult>
	/** Idempotently aborts caller-owned queued/running work and waits for it to settle. */
	close(): Promise<void>
}>

type NormalizedExtension = Readonly<{
	name: string
	requiredFeatures?: MarkdownExtensionFeatures
	create: MarkdownExtension['create']
}>

type MarkdownGeneration = Readonly<{
	controller: AbortController
	limits: MarkdownRenderLimits
	renderers: Set<MarkdownRendererState>
}>

type MarkdownRendererState = {
	readonly controller: AbortController
	readonly extensions: readonly NormalizedExtension[]
	readonly generation: MarkdownGeneration
	readonly owner: Context
	readonly pending: Set<Promise<unknown>>
	readonly theme: MarkdownTheme
	active: boolean
}

type PreparedMarkdown = Readonly<{
	content: string
	images: readonly TakumiImageInput[]
	closeAssets(): void
}>

@Plugin()
export class TakumiMarkdownPlugin extends BasePlugin {
	private readonly config = this.configs.use(TakumiMarkdownConfig)
	private generation?: MarkdownGeneration

	constructor(private readonly takumi: TakumiPlugin) {
		super()
	}

	override init(): void {
		const generation: MarkdownGeneration = Object.freeze({
			controller: new AbortController(),
			limits: createMarkdownRenderLimits(this.config),
			renderers: new Set<MarkdownRendererState>(),
		})
		this.generation = generation
		this.ctx.effects.defer(
			async () => {
				if (this.generation === generation) this.generation = undefined
				const reason = new MarkdownError(
					'NOT_RUNNING',
					'Markdown rendering belongs to a stopped plugin generation',
				)
				generation.controller.abort(reason)
				await Promise.allSettled(
					[...generation.renderers].map((renderer) => this.closeRenderer(renderer, reason)),
				)
			},
			{ tag: 'takumi-markdown-generation' },
		)
	}

	/**
	 * Creates a caller-generation-owned renderer. Its extension list is snapshotted now and cannot
	 * be changed per request; owner stop/replacement automatically closes the handle.
	 */
	createRenderer(options: MarkdownRendererOptions = {}): MarkdownRenderer {
		const generation = this.requireGeneration()
		const normalized = normalizeRendererOptions(options, this.config.maxExtensions)
		const owner = this.ctx.caller ?? this.ctx
		const state: MarkdownRendererState = {
			active: true,
			controller: new AbortController(),
			extensions: normalized.extensions,
			generation,
			owner,
			pending: new Set(),
			theme: normalized.theme,
		}
		generation.renderers.add(state)
		try {
			owner.effects.defer(
				() =>
					this.closeRenderer(
						state,
						new MarkdownError(
							'NOT_RUNNING',
							'Markdown renderer belongs to a stopped caller generation',
						),
					),
				{ tag: 'takumi-markdown-renderer' },
			)
		} catch (cause) {
			void this.closeRenderer(
				state,
				new MarkdownError('NOT_RUNNING', 'Markdown renderer caller is stopped', { cause }),
			)
			throw new MarkdownError('NOT_RUNNING', 'Markdown renderer caller is stopped', { cause })
		}
		return Object.freeze({
			render: (input) => this.trackRenderer(state, this.renderRaster(state, input)),
			renderSvg: (input) => this.trackRenderer(state, this.renderSvg(state, input)),
			close: () => this.closeRenderer(state),
		})
	}

	private async renderRaster(
		state: MarkdownRendererState,
		input: MarkdownRenderInput,
	): Promise<TakumiRenderResult> {
		validateMarkdownInput(input)
		this.assertRendererActive(state)
		const abortLink = linkAbortSignals([
			state.generation.controller.signal,
			state.controller.signal,
			input.signal,
		])
		let reservation: TakumiRenderReservation | undefined
		let prepared: PreparedMarkdown | undefined
		try {
			reservation = await this.takumi.reserveRender({ signal: abortLink.signal })
			prepared = await this.prepareMarkdown(state, input, reservation)
			return await reservation.render({
				content: prepared.content,
				width: input.width,
				height: input.height,
				...(input.devicePixelRatio === undefined
					? {}
					: { devicePixelRatio: input.devicePixelRatio }),
				stylesheets: [
					MARKDOWN_STYLESHEET,
					...(input.stylesheets === undefined ? [] : input.stylesheets),
				],
				images: [...(input.images === undefined ? [] : input.images), ...prepared.images],
				...(input.output === undefined ? {} : { output: input.output }),
			})
		} finally {
			prepared?.closeAssets()
			if (reservation) await reservation.close()
			abortLink.dispose()
		}
	}

	private async renderSvg(
		state: MarkdownRendererState,
		input: MarkdownSvgRenderInput,
	): Promise<TakumiSvgRenderResult> {
		validateMarkdownInput(input)
		this.assertRendererActive(state)
		const abortLink = linkAbortSignals([
			state.generation.controller.signal,
			state.controller.signal,
			input.signal,
		])
		let reservation: TakumiRenderReservation | undefined
		let prepared: PreparedMarkdown | undefined
		try {
			reservation = await this.takumi.reserveRender({ signal: abortLink.signal })
			prepared = await this.prepareMarkdown(state, input, reservation)
			return await reservation.renderSvg({
				content: prepared.content,
				width: input.width,
				height: input.height,
				stylesheets: [
					MARKDOWN_STYLESHEET,
					...(input.stylesheets === undefined ? [] : input.stylesheets),
				],
				images: [...(input.images === undefined ? [] : input.images), ...prepared.images],
			})
		} finally {
			prepared?.closeAssets()
			if (reservation) await reservation.close()
			abortLink.dispose()
		}
	}

	private async prepareMarkdown(
		state: MarkdownRendererState,
		input: MarkdownRenderInput | MarkdownSvgRenderInput,
		reservation: TakumiRenderReservation,
	): Promise<PreparedMarkdown> {
		const signal = reservation.signal
		await assertUtf8Limit(
			input.markdown,
			state.generation.limits.maxSourceBytes,
			signal,
			'MARKDOWN_TOO_LARGE',
			'Markdown source exceeds the configured byte limit',
		)
		assertNoInternalAssetSource(input.images)
		const assets = createAssetCollector({
			limits: state.generation.limits,
			signal,
			takumiLimits: reservation.limits,
		})
		try {
			const pipeline = await this.resolveExtensionPipeline(
				state,
				input.markdown,
				signal,
				assets.sink,
			)
			const result = await this.compileMarkdown(
				input.markdown,
				pipeline,
				state.generation.limits,
				signal,
			)
			const theme = input.theme ?? state.theme
			const content =
				'<article class="pluxel-markdown pluxel-markdown--' +
				theme +
				'">' +
				result.html +
				'</article>'
			await assertUtf8Limit(
				content,
				Math.min(state.generation.limits.maxHtmlBytes, reservation.limits.maxContentBytes),
				signal,
				'HTML_TOO_LARGE',
				'Markdown output exceeds the configured HTML byte limit',
			)
			return Object.freeze({
				content,
				images: Object.freeze([...assets.images]),
				closeAssets: assets.close,
			})
		} catch (cause) {
			assets.close()
			throw normalizeMarkdownFailure(cause)
		}
	}

	private async resolveExtensionPipeline(
		state: MarkdownRendererState,
		source: string,
		signal: AbortSignal,
		assets: MarkdownAssetSink,
	): Promise<
		Readonly<{
			features: Features
			hast: readonly HastPluginEntry[]
			mdast: readonly MdastPluginEntry[]
		}>
	> {
		const mdast: MdastPluginEntry[] = []
		const hast: HastPluginEntry[] = []
		const features = resolveFeatures(state.extensions)
		for (const extension of state.extensions) {
			signal.throwIfAborted()
			let pipeline: MarkdownExtensionPipeline | null
			try {
				pipeline =
					(await extension.create(
						Object.freeze({
							source,
							signal,
							assets,
							limits: state.generation.limits,
						}),
					)) ?? null
			} catch (cause) {
				throw extensionFailure(extension.name, cause)
			}
			signal.throwIfAborted()
			if (pipeline === null) continue
			if (!isRecord(pipeline) || Array.isArray(pipeline)) {
				throw new MarkdownError(
					'EXTENSION_FAILED',
					'Markdown extension "' + extension.name + '" returned an invalid pipeline',
				)
			}
			if (pipeline.mdast !== undefined) {
				if (!Array.isArray(pipeline.mdast)) {
					throw new MarkdownError(
						'EXTENSION_FAILED',
						'Markdown extension "' + extension.name + '" returned invalid MDAST plugins',
					)
				}
				mdast.push(...pipeline.mdast)
			}
			if (pipeline.hast !== undefined) {
				if (!Array.isArray(pipeline.hast)) {
					throw new MarkdownError(
						'EXTENSION_FAILED',
						'Markdown extension "' + extension.name + '" returned invalid HAST plugins',
					)
				}
				hast.push(...pipeline.hast)
			}
		}
		return Object.freeze({
			features,
			hast: Object.freeze(hast),
			mdast: Object.freeze(mdast),
		})
	}

	private async compileMarkdown(
		source: string,
		pipeline: Readonly<{
			features: Features
			hast: readonly HastPluginEntry[]
			mdast: readonly MdastPluginEntry[]
		}>,
		limits: MarkdownRenderLimits,
		signal: AbortSignal,
	): Promise<Readonly<{ html: string }>> {
		try {
			signal.throwIfAborted()
			const result = await markdownToHtml(source, {
				features: pipeline.features,
				mdastPlugins: [...pipeline.mdast, createMdastBudgetPlugin(limits.maxAstNodes, signal)],
				hastPlugins: [
					createCodeHighlighter(limits, signal),
					...pipeline.hast,
					createHastBudgetPlugin(limits.maxAstNodes, signal),
					removeRawHtml,
				],
			})
			return Object.freeze({ html: result.html })
		} catch (cause) {
			throw normalizeMarkdownFailure(cause)
		}
	}

	private trackRenderer<T>(state: MarkdownRendererState, operation: Promise<T>): Promise<T> {
		state.pending.add(operation)
		void operation.then(
			() => state.pending.delete(operation),
			() => state.pending.delete(operation),
		)
		return operation
	}

	private async closeRenderer(
		state: MarkdownRendererState,
		reason = new MarkdownError('NOT_RUNNING', 'Markdown renderer was closed'),
	): Promise<void> {
		if (!state.active) {
			await Promise.allSettled(state.pending)
			return
		}
		state.active = false
		state.generation.renderers.delete(state)
		state.controller.abort(reason)
		await Promise.allSettled(state.pending)
	}

	private requireGeneration(): MarkdownGeneration {
		const generation = this.generation
		if (!generation || generation.controller.signal.aborted) {
			throw new MarkdownError('NOT_RUNNING', 'TakumiMarkdownPlugin is not running')
		}
		return generation
	}

	private assertRendererActive(state: MarkdownRendererState): void {
		if (!state.active || state.generation.controller.signal.aborted) {
			throw new MarkdownError(
				'NOT_RUNNING',
				'Markdown renderer is closed or belongs to a stopped generation',
			)
		}
	}
}

const removeRawHtml = defineHastPlugin({
	name: 'pluxel-markdown-remove-raw-html',
	raw(node, context) {
		context.removeNode(node)
	},
})

function createMdastBudgetPlugin(maxNodes: number, signal: AbortSignal) {
	return defineMdastPlugin({
		name: 'pluxel-markdown-mdast-budget',
		before: (root) => assertTreeNodeLimit(root, maxNodes, signal),
	})
}

function createHastBudgetPlugin(maxNodes: number, signal: AbortSignal) {
	return defineHastPlugin({
		name: 'pluxel-markdown-hast-budget',
		before: (root) => assertTreeNodeLimit(root, maxNodes, signal),
	})
}

function createCodeHighlighter(limits: MarkdownRenderLimits, signal: AbortSignal) {
	let blocks = 0
	let bytes = 0
	return defineHastPlugin({
		name: 'pluxel-markdown-rangi',
		element: {
			filter: ['pre'],
			visit(node, context) {
				signal.throwIfAborted()
				const code = node.children.find(
					(child): child is typeof node => child.type === 'element' && child.tagName === 'code',
				)
				if (!code) return
				blocks += 1
				if (blocks > limits.maxCodeBlocks) {
					throw new MarkdownError(
						'CODE_LIMIT_EXCEEDED',
						'Markdown exceeds the configured code-block limit',
					)
				}
				const source = context.textContent(code)
				const blockBytes = Buffer.byteLength(source, 'utf8')
				bytes += blockBytes
				if (blockBytes > limits.maxCodeBlockBytes || bytes > limits.maxTotalCodeBytes) {
					throw new MarkdownError(
						'CODE_LIMIT_EXCEEDED',
						'Markdown code exceeds the configured byte limit',
					)
				}
				const language = canonicalFenceLanguage(readFenceLanguage(code.properties.className))
				const highlighted = htmlToHast(codeToHtml(source, { classes: true, lang: language }), {
					fragment: true,
				})
				if (highlighted.type === 'root') context.replaceNode(node, highlighted.children)
			},
		},
	})
}

function normalizeRendererOptions(
	value: MarkdownRendererOptions,
	maxExtensions: number,
): Readonly<{ extensions: readonly NormalizedExtension[]; theme: MarkdownTheme }> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new MarkdownError('INVALID_INPUT', 'createRenderer() options must be an object')
	}
	const theme = value.theme ?? 'light'
	if (theme !== 'light' && theme !== 'dark') {
		throw new MarkdownError('INVALID_INPUT', 'Markdown renderer theme must be light or dark')
	}
	const supplied = value.extensions ?? []
	if (!Array.isArray(supplied) || supplied.length > maxExtensions) {
		throw new MarkdownError(
			'INVALID_INPUT',
			'extensions must be an array with at most ' + maxExtensions + ' entries',
		)
	}
	const names = new Set<string>()
	const extensions: NormalizedExtension[] = []
	for (const candidate of supplied) {
		if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
			throw new MarkdownError('INVALID_INPUT', 'Every Markdown extension must be an object')
		}
		const extension = candidate as MarkdownExtension
		if (
			typeof extension.name !== 'string' ||
			!extension.name ||
			extension.name !== extension.name.trim() ||
			extension.name.length > MAX_EXTENSION_NAME_LENGTH ||
			hasControlCharacters(extension.name) ||
			typeof extension.create !== 'function'
		) {
			throw new MarkdownError('INVALID_INPUT', 'Markdown extension name or factory is invalid')
		}
		if (names.has(extension.name)) {
			throw new MarkdownError(
				'INVALID_INPUT',
				'Duplicate Markdown extension name: ' + extension.name,
			)
		}
		names.add(extension.name)
		extensions.push(
			Object.freeze({
				name: extension.name,
				...(extension.requiredFeatures === undefined
					? {}
					: { requiredFeatures: normalizeExtensionFeatures(extension.requiredFeatures) }),
				create: extension.create,
			}),
		)
	}
	return Object.freeze({ extensions: Object.freeze(extensions), theme })
}

function normalizeExtensionFeatures(value: MarkdownExtensionFeatures): MarkdownExtensionFeatures {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new MarkdownError('INVALID_INPUT', 'Markdown extension features must be an object')
	}
	const candidate = value as Record<string, unknown>
	const normalized: {
		-readonly [Key in keyof MarkdownExtensionFeatures]: MarkdownExtensionFeatures[Key]
	} = {}
	for (const key of Object.keys(candidate)) {
		const option = candidate[key]
		if (option === undefined) continue
		switch (key) {
			case 'math':
				normalized.math = normalizeMathFeature(option)
				break
			case 'smartPunctuation':
				normalized.smartPunctuation = normalizeSmartPunctuationFeature(option)
				break
			case 'headingAttributes':
				normalized.headingAttributes = normalizeBooleanFeature(option, key)
				break
			case 'directive':
				normalized.directive = normalizeBooleanFeature(option, key)
				break
			case 'superscript':
				normalized.superscript = normalizeBooleanFeature(option, key)
				break
			case 'subscript':
				normalized.subscript = normalizeBooleanFeature(option, key)
				break
			case 'wikilinks':
				normalized.wikilinks = normalizeBooleanFeature(option, key)
				break
			case 'definitionList':
				normalized.definitionList = normalizeBooleanFeature(option, key)
				break
			default:
				throw new MarkdownError(
					'INVALID_INPUT',
					'Markdown extensions cannot change the ' + key + ' parser feature',
				)
		}
	}
	return Object.freeze(normalized)
}

function normalizeMathFeature(value: unknown): NonNullable<Features['math']> {
	if (typeof value === 'boolean') return value
	if (!isRecord(value)) throw invalidFeatureOption('math')
	for (const key of Object.keys(value)) {
		if (key !== 'singleDollarTextMath') throw invalidFeatureOption('math')
	}
	const singleDollarTextMath = normalizeOptionalBoolean(value.singleDollarTextMath, 'math')
	return Object.freeze(singleDollarTextMath === undefined ? {} : { singleDollarTextMath })
}

function normalizeSmartPunctuationFeature(
	value: unknown,
): NonNullable<Features['smartPunctuation']> {
	if (typeof value === 'boolean') return value
	if (!isRecord(value)) throw invalidFeatureOption('smartPunctuation')
	for (const key of Object.keys(value)) {
		if (key !== 'quotes' && key !== 'dashes' && key !== 'ellipses') {
			throw invalidFeatureOption('smartPunctuation')
		}
	}
	const quotes = normalizeOptionalBoolean(value.quotes, 'smartPunctuation')
	const dashes = normalizeOptionalBoolean(value.dashes, 'smartPunctuation')
	const ellipses = normalizeOptionalBoolean(value.ellipses, 'smartPunctuation')
	return Object.freeze({
		...(quotes === undefined ? {} : { quotes }),
		...(dashes === undefined ? {} : { dashes }),
		...(ellipses === undefined ? {} : { ellipses }),
	})
}

function normalizeBooleanFeature(value: unknown, feature: string): boolean {
	if (typeof value !== 'boolean') throw invalidFeatureOption(feature)
	return value
}

function normalizeOptionalBoolean(value: unknown, feature: string): boolean | undefined {
	if (value === undefined) return undefined
	return normalizeBooleanFeature(value, feature)
}

function invalidFeatureOption(feature: string): MarkdownError {
	return new MarkdownError(
		'INVALID_INPUT',
		'Markdown extension feature ' + feature + ' must use its documented boolean or option shape',
	)
}

function resolveFeatures(extensions: readonly NormalizedExtension[]): Features {
	let math: Features['math']
	let smartPunctuation: Features['smartPunctuation']
	const enabled: Partial<
		Pick<
			Features,
			| 'headingAttributes'
			| 'directive'
			| 'superscript'
			| 'subscript'
			| 'wikilinks'
			| 'definitionList'
		>
	> = {}
	for (const extension of extensions) {
		const features = extension.requiredFeatures
		if (!features) continue
		if (features.math !== undefined) math = mergeFeatureOption(math, features.math)
		if (features.smartPunctuation !== undefined) {
			smartPunctuation = mergeFeatureOption(smartPunctuation, features.smartPunctuation)
		}
		for (const key of [
			'headingAttributes',
			'directive',
			'superscript',
			'subscript',
			'wikilinks',
			'definitionList',
		] as const) {
			if (features[key]) enabled[key] = true
		}
	}
	return Object.freeze({
		gfm: true,
		rawHtml: false,
		...(math === undefined ? {} : { math }),
		...(smartPunctuation === undefined ? {} : { smartPunctuation }),
		...enabled,
	})
}

function mergeFeatureOption<T extends boolean | object | undefined>(current: T, next: T): T {
	if (current === undefined || next === undefined) return (next ?? current) as T
	if (typeof current === 'object' && typeof next === 'object') {
		return Object.freeze({ ...current, ...next }) as T
	}
	return next
}

function validateMarkdownInput(input: MarkdownRenderInput | MarkdownSvgRenderInput): void {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		throw new MarkdownError('INVALID_INPUT', 'Markdown render input must be an object')
	}
	if (typeof input.markdown !== 'string') {
		throw new MarkdownError('INVALID_INPUT', 'markdown must be a string')
	}
	if (!Number.isSafeInteger(input.width) || !Number.isSafeInteger(input.height)) {
		throw new MarkdownError('INVALID_INPUT', 'Markdown width and height must be integers')
	}
	if (input.width <= 0 || input.height <= 0) {
		throw new MarkdownError('INVALID_INPUT', 'Markdown width and height must be positive')
	}
	if (input.signal !== undefined && !isAbortSignal(input.signal)) {
		throw new MarkdownError('INVALID_INPUT', 'signal must be an AbortSignal')
	}
	if (input.theme !== undefined && input.theme !== 'light' && input.theme !== 'dark') {
		throw new MarkdownError('INVALID_INPUT', 'Markdown theme must be light or dark')
	}
}

function createAssetCollector(
	input: Readonly<{
		limits: MarkdownRenderLimits
		signal: AbortSignal
		takumiLimits: TakumiRenderLimits
	}>,
): Readonly<{
	sink: MarkdownAssetSink
	images: readonly TakumiImageInput[]
	close(): void
}> {
	const images: TakumiImageInput[] = []
	const prefix = INTERNAL_ASSET_PREFIX + crypto.randomUUID() + '/'
	const perAssetLimit = Math.min(input.limits.maxAssetBytes, input.takumiLimits.maxImageBytes)
	const totalLimit = Math.min(input.limits.maxTotalAssetBytes, input.takumiLimits.maxImageBytes)
	let active = true
	let nextAsset = 0
	let pendingAssets = 0
	let reservedBytes = 0
	let totalBytes = 0
	const sink: MarkdownAssetSink = Object.freeze({
		async add(asset: MarkdownAssetInput): Promise<string> {
			if (!active) {
				throw new MarkdownError('NOT_RUNNING', 'Generated Markdown asset sink is no longer active')
			}
			if (input.signal.aborted) input.signal.throwIfAborted()
			if (!asset || typeof asset !== 'object' || !(asset.data instanceof Uint8Array)) {
				throw new MarkdownError(
					'INVALID_INPUT',
					'Generated Markdown asset requires Uint8Array data',
				)
			}
			if (!isAssetMediaType(asset.mediaType)) {
				throw new MarkdownError(
					'INVALID_INPUT',
					'Generated Markdown asset media type is unsupported',
				)
			}
			if (asset.data.buffer instanceof SharedArrayBuffer || asset.data.byteLength === 0) {
				throw new MarkdownError('INVALID_INPUT', 'Generated Markdown asset bytes are invalid')
			}
			if (images.length + pendingAssets >= input.limits.maxAssets) {
				throw new MarkdownError(
					'ASSET_COUNT_EXCEEDED',
					'Markdown extensions exceed the configured generated-asset limit',
				)
			}
			if (asset.data.byteLength > perAssetLimit) {
				throw new MarkdownError(
					'ASSET_TOO_LARGE',
					'Generated Markdown asset exceeds the configured byte limit',
				)
			}
			if (asset.data.byteLength > totalLimit - totalBytes - reservedBytes) {
				throw new MarkdownError(
					'ASSET_BYTES_EXCEEDED',
					'Generated Markdown assets exceed the configured byte limit',
				)
			}
			const source = prefix + nextAsset + mediaTypeSuffix(asset.mediaType)
			nextAsset += 1
			pendingAssets += 1
			reservedBytes += asset.data.byteLength
			try {
				const data = await copyBytes(asset.data, input.signal)
				if (!active) {
					throw new MarkdownError(
						'NOT_RUNNING',
						'Generated Markdown asset sink is no longer active',
					)
				}
				input.signal.throwIfAborted()
				totalBytes += data.byteLength
				images.push(Object.freeze({ src: source, data }))
				return source
			} finally {
				pendingAssets -= 1
				reservedBytes -= asset.data.byteLength
			}
		},
	})
	return Object.freeze({
		sink,
		images,
		close() {
			active = false
		},
	})
}

function assertNoInternalAssetSource(images: readonly TakumiImageInput[] | undefined): void {
	if (!Array.isArray(images)) return
	for (const image of images) {
		if (
			image &&
			typeof image === 'object' &&
			typeof (image as TakumiImageInput).src === 'string' &&
			(image as TakumiImageInput).src.startsWith(INTERNAL_ASSET_PREFIX)
		) {
			throw new MarkdownError(
				'INTERNAL_ASSET_COLLISION',
				'Caller image sources cannot use the reserved Markdown asset namespace',
			)
		}
	}
}

async function assertTreeNodeLimit(
	root: unknown,
	maxNodes: number,
	signal: AbortSignal,
): Promise<void> {
	signal.throwIfAborted()
	const stack: unknown[] = [root]
	let visited = 0
	while (stack.length > 0) {
		if (++visited > maxNodes) {
			throw new MarkdownError(
				'AST_LIMIT_EXCEEDED',
				'Markdown AST exceeds the configured ' + maxNodes + ' node limit',
			)
		}
		if (visited % 512 === 0) await yieldToEventLoop(signal)
		const node = stack.pop()
		if (!node || typeof node !== 'object') continue
		const children = (node as { children?: unknown }).children
		if (!Array.isArray(children)) continue
		for (let index = children.length - 1; index >= 0; index -= 1) {
			stack.push(children[index])
		}
	}
}

async function assertUtf8Limit(
	value: string,
	maxBytes: number,
	signal: AbortSignal,
	code: MarkdownErrorCode,
	message: string,
): Promise<void> {
	signal.throwIfAborted()
	let bytes = 0
	for (let offset = 0; offset < value.length;) {
		let end = Math.min(offset + UTF8_CHUNK_CHARACTERS, value.length)
		if (
			end < value.length &&
			isHighSurrogate(value.charCodeAt(end - 1)) &&
			isLowSurrogate(value.charCodeAt(end))
		) {
			end += 1
		}
		bytes += Buffer.byteLength(value.slice(offset, end), 'utf8')
		if (bytes > maxBytes) throw new MarkdownError(code, message)
		offset = end
		if (offset < value.length) await yieldToEventLoop(signal)
	}
}

async function copyBytes(data: Uint8Array, signal: AbortSignal): Promise<Uint8Array> {
	signal.throwIfAborted()
	const copy = new Uint8Array(data.byteLength)
	const chunkBytes = 1024 * 1024
	for (let offset = 0; offset < data.byteLength; offset += chunkBytes) {
		if (offset > 0) await yieldToEventLoop(signal)
		copy.set(data.subarray(offset, Math.min(offset + chunkBytes, data.byteLength)), offset)
	}
	return copy
}

function canonicalFenceLanguage(value: string | undefined): string {
	if (!value) return 'plain'
	const language = value.toLocaleLowerCase('en-US')
	const aliases: Readonly<Record<string, string>> = {
		bash: 'bash',
		c: 'c',
		cpp: 'cpp',
		cs: 'cs',
		csharp: 'cs',
		css: 'css',
		dockerfile: 'docker',
		go: 'go',
		golang: 'go',
		html: 'html',
		java: 'java',
		javascript: 'js',
		js: 'js',
		json: 'json',
		jsonc: 'json',
		jsx: 'jsx',
		kotlin: 'kotlin',
		lua: 'lua',
		markdown: 'markdown',
		md: 'markdown',
		php: 'php',
		py: 'py',
		python: 'py',
		rust: 'rust',
		rs: 'rust',
		scss: 'scss',
		sh: 'bash',
		shell: 'bash',
		sql: 'sql',
		svelte: 'svelte',
		toml: 'toml',
		ts: 'ts',
		tsx: 'tsx',
		typescript: 'ts',
		vue: 'vue',
		xml: 'xml',
		yaml: 'yaml',
		yml: 'yaml',
	}
	return aliases[language] ?? 'plain'
}

function readFenceLanguage(value: unknown): string | undefined {
	const classNames = Array.isArray(value)
		? value
		: typeof value === 'string'
			? value.split(/\s+/)
			: []
	for (const className of classNames) {
		if (typeof className === 'string' && className.startsWith('language-')) {
			return className.slice('language-'.length)
		}
	}
	return undefined
}

function extensionFailure(name: string, cause: unknown): Error {
	if (shouldPreserveFailure(cause)) return cause
	return new MarkdownError('EXTENSION_FAILED', 'Markdown extension "' + name + '" failed', {
		cause,
	})
}

function normalizeMarkdownFailure(cause: unknown): Error {
	if (shouldPreserveFailure(cause)) return cause
	return new MarkdownError('EXTENSION_FAILED', 'Markdown conversion failed', { cause })
}

function shouldPreserveFailure(cause: unknown): cause is Error {
	return (
		cause instanceof MarkdownError ||
		cause instanceof TakumiError ||
		(cause instanceof Error &&
			(cause.name === 'TypstMathError' || cause.name === 'WorkerTaskError'))
	)
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

async function yieldToEventLoop(signal: AbortSignal): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve))
	signal.throwIfAborted()
}

function isAbortSignal(value: unknown): value is AbortSignal {
	return (
		Boolean(value && typeof value === 'object') &&
		typeof (value as AbortSignal).aborted === 'boolean' &&
		typeof (value as AbortSignal).addEventListener === 'function' &&
		typeof (value as AbortSignal).removeEventListener === 'function'
	)
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isAssetMediaType(value: unknown): value is MarkdownAssetMediaType {
	return (
		value === 'image/svg+xml' ||
		value === 'image/png' ||
		value === 'image/jpeg' ||
		value === 'image/webp'
	)
}

function mediaTypeSuffix(value: MarkdownAssetMediaType): string {
	return value === 'image/svg+xml'
		? '.svg'
		: value === 'image/png'
			? '.png'
			: value === 'image/jpeg'
				? '.jpg'
				: '.webp'
}

function hasControlCharacters(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index)
		if (code <= 0x1f || code === 0x7f) return true
	}
	return false
}

function isHighSurrogate(value: number): boolean {
	return value >= 0xd800 && value <= 0xdbff
}

function isLowSurrogate(value: number): boolean {
	return value >= 0xdc00 && value <= 0xdfff
}

export { MarkdownError, TakumiMarkdownConfig }
export type { MarkdownErrorCode, MarkdownRenderLimits, TakumiMarkdownPluginConfig }
