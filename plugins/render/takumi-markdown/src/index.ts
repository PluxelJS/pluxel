import { BasePlugin, definePluginRef, Plugin } from '@pluxel/core'
import type { TypstPlugin } from '@pluxel/typst'
import {
	TakumiPlugin,
	type CssInput,
	type WorkerRenderOptions,
	type WorkerSvgRenderOptions,
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
import { createTypstMathExtension } from './math.ts'

const Typst = definePluginRef<TypstPlugin>()

const INTERNAL_ASSET_PREFIX = 'pluxel://markdown-internal/'
const UTF8_CHUNK_CHARACTERS = 64 * 1024
const MAX_EXTENSION_NAME_LENGTH = 128

export type MarkdownTheme = 'light' | 'dark'

export type MarkdownAssetMediaType = 'image/svg+xml' | 'image/png' | 'image/jpeg' | 'image/webp'

export type MarkdownAssetInput = Readonly<{
	/** Bytes are borrowed until add() settles and then owned by this render. */
	data: Uint8Array
	mediaType: MarkdownAssetMediaType
}>

export type MarkdownAssetSink = Readonly<{
	/**
	 * Copies an image under an allocated internal source. The sink performs no IO and expires
	 * after this render settles.
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
	/** The resolved renderer default or per-render theme. */
	theme: MarkdownTheme
	signal: AbortSignal
	assets: MarkdownAssetSink
	limits: MarkdownRenderLimits
}>

export type MarkdownExtensionPipeline = Readonly<{
	mdast?: readonly MdastPluginEntry[]
	hast?: readonly HastPluginEntry[]
}>

/**
 * Trusted startup-time composition. Extension factories run once for each render,
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

/** Shared-worker Takumi options using css for styles, plus a document theme. */
export type MarkdownRenderOptions = WorkerRenderOptions &
	Readonly<{ theme?: MarkdownTheme; stylesheets?: never }>
export type MarkdownSvgRenderOptions = WorkerSvgRenderOptions &
	Readonly<{ theme?: MarkdownTheme; stylesheets?: never }>

export interface MarkdownRenderer extends AsyncDisposable {
	render(
		markdown: string,
		options?: MarkdownRenderOptions,
	): ReturnType<TakumiPlugin['renderInWorker']>
	renderSvg(
		markdown: string,
		options?: MarkdownSvgRenderOptions,
	): ReturnType<TakumiPlugin['renderSvgInWorker']>
	/** Abort this renderer's work and wait for it to settle. Safe to call repeatedly. */
	close(): Promise<void>
}

type NormalizedExtension = Readonly<{
	name: string
	requiredFeatures?: MarkdownExtensionFeatures
	create: MarkdownExtension['create']
}>
type MarkdownGeneration = Readonly<{
	controller: AbortController
	limits: MarkdownRenderLimits
	math?: MarkdownExtension
	pending: Set<Promise<unknown>>
}>
type MarkdownRendererState = Readonly<{
	controller: AbortController
	generation: MarkdownGeneration
	extensions: readonly NormalizedExtension[]
	theme: MarkdownTheme
	pending: Set<Promise<unknown>>
}>
type GeneratedImage = Readonly<{ src: string; data: Uint8Array }>
type ImagesInput = NonNullable<WorkerRenderOptions['images']>
type PreparedOptions = { signal: AbortSignal; css: CssInput[]; images: ImagesInput }

@Plugin()
export class TakumiMarkdownPlugin extends BasePlugin {
	private readonly config = this.configs.use(TakumiMarkdownConfig)
	private generation?: MarkdownGeneration

	constructor(private readonly takumi: TakumiPlugin) {
		super()
	}

	override init(): void {
		let math: MarkdownExtension | undefined
		this.plugins.use(Typst, (typst) => {
			math = createTypstMathExtension(typst, Object.freeze({ ...this.config.math }))
		})
		const generation: MarkdownGeneration = {
			controller: new AbortController(),
			limits: createMarkdownRenderLimits(this.config),
			math,
			pending: new Set(),
		}
		this.generation = generation
		this.ctx.effects.defer(
			async () => {
				if (this.generation === generation) this.generation = undefined
				generation.controller.abort(new MarkdownError('NOT_RUNNING', 'Markdown provider stopped'))
				await Promise.allSettled(generation.pending)
			},
			{ tag: 'markdown-generation' },
		)
	}

	/** Creates a renderer owned by the current caller generation. */
	createRenderer(options: MarkdownRendererOptions = {}): MarkdownRenderer {
		const generation = this.generation
		if (!generation || generation.controller.signal.aborted) {
			throw new MarkdownError('NOT_RUNNING', 'TakumiMarkdownPlugin is not running')
		}
		const normalized = normalizeRendererOptions(options, this.config.maxExtensions)
		const state: MarkdownRendererState = {
			controller: new AbortController(),
			generation,
			extensions: generation.math
				? Object.freeze([...normalized.extensions, generation.math])
				: normalized.extensions,
			theme: normalized.theme,
			pending: new Set(),
		}
		let cleanup: { cancel(): void } | undefined
		const close = async (): Promise<void> => {
			cleanup?.cancel()
			state.controller.abort(new MarkdownError('NOT_RUNNING', 'Markdown renderer was closed'))
			await Promise.allSettled(state.pending)
		}
		cleanup = (this.ctx.caller ?? this.ctx).effects.defer(close, { tag: 'markdown-renderer' })
		return Object.freeze({
			render: (source: string, input: MarkdownRenderOptions = {}) => {
				const { theme: _, ...native } = input
				return this.track(
					state,
					this.renderMarkdown(state, source, input, (html, prepared) =>
						this.takumi.renderInWorker(html, { ...native, ...prepared }),
					),
				)
			},
			renderSvg: (source: string, input: MarkdownSvgRenderOptions = {}) => {
				const { theme: _, ...native } = input
				return this.track(
					state,
					this.renderMarkdown(state, source, input, (html, prepared) =>
						this.takumi.renderSvgInWorker(html, { ...native, ...prepared }),
					),
				)
			},
			close,
			[Symbol.asyncDispose]: close,
		})
	}

	private async renderMarkdown<T>(
		state: MarkdownRendererState,
		source: string,
		options: MarkdownRenderOptions | MarkdownSvgRenderOptions,
		render: (html: string, prepared: PreparedOptions) => Promise<T>,
	): Promise<T> {
		const signal = AbortSignal.any([
			state.generation.controller.signal,
			state.controller.signal,
			...(options.signal ? [options.signal] : []),
		])
		signal.throwIfAborted()
		if (typeof source !== 'string')
			throw new MarkdownError('INVALID_INPUT', 'Markdown must be a string')
		const theme = options.theme ?? state.theme
		if (theme !== 'light' && theme !== 'dark') {
			throw new MarkdownError('INVALID_INPUT', 'Markdown theme must be light or dark')
		}
		const limits = state.generation.limits
		await assertUtf8Limit(
			source,
			limits.maxSourceBytes,
			signal,
			'MARKDOWN_TOO_LARGE',
			'Markdown source exceeds the configured byte limit',
		)
		const assets = createAssetCollector({ limits, signal })
		try {
			const mdast: MdastPluginEntry[] = []
			const hast: HastPluginEntry[] = []
			for (const extension of state.extensions) {
				signal.throwIfAborted()
				const pipeline = await extension.create(
					Object.freeze({ source, theme, signal, assets: assets.sink, limits }),
				)
				if (pipeline == null) continue
				if (
					!isRecord(pipeline) ||
					(pipeline.mdast !== undefined && !Array.isArray(pipeline.mdast)) ||
					(pipeline.hast !== undefined && !Array.isArray(pipeline.hast))
				) {
					throw new MarkdownError(
						'EXTENSION_FAILED',
						`Invalid pipeline from Markdown extension "${extension.name}"`,
					)
				}
				mdast.push(...(pipeline.mdast ?? []))
				hast.push(...(pipeline.hast ?? []))
			}
			const result = await markdownToHtml(source, {
				features: resolveFeatures(state.extensions),
				mdastPlugins: [...mdast, createMdastBudgetPlugin(limits.maxAstNodes, signal)],
				hastPlugins: [
					createCodeHighlighter(limits, signal),
					...hast,
					createHastBudgetPlugin(limits.maxAstNodes, signal),
					removeRawHtml,
				],
			})
			signal.throwIfAborted()
			const html = `<article class="pluxel-markdown pluxel-markdown--${theme}">${result.html}</article>`
			await assertUtf8Limit(
				html,
				limits.maxHtmlBytes,
				signal,
				'HTML_TOO_LARGE',
				'Markdown output exceeds the configured HTML byte limit',
			)
			return await render(html, {
				signal,
				css: [
					MARKDOWN_STYLESHEET,
					...(Array.isArray(options.css)
						? options.css
						: options.css === undefined
							? []
							: [options.css]),
				],
				images: mergeImages(options.images, assets.images),
			})
		} finally {
			assets.close()
		}
	}

	private track<T>(state: MarkdownRendererState, operation: Promise<T>): Promise<T> {
		state.pending.add(operation)
		state.generation.pending.add(operation)
		const release = () => {
			state.pending.delete(operation)
			state.generation.pending.delete(operation)
		}
		void operation.then(release, release)
		return operation
	}
}

/** Generated assets join the native image pipeline; Markdown URLs require explicit opt-in. */
function mergeImages(
	input: ImagesInput | undefined,
	generated: readonly GeneratedImage[],
): ImagesInput {
	const group: Exclude<ImagesInput, readonly unknown[]> | undefined = isImageSources(input)
		? { sources: input }
		: input
	const sources = group?.sources ?? []
	if (sources.some((image) => image.src.startsWith(INTERNAL_ASSET_PREFIX))) {
		throw new MarkdownError(
			'INTERNAL_ASSET_COLLISION',
			'Caller images use the reserved Markdown asset namespace',
		)
	}
	return {
		...group,
		allowRemote: group?.allowRemote ?? false,
		sources: [...sources, ...generated],
	}
}

function isImageSources(
	input: ImagesInput | undefined,
): input is Extract<ImagesInput, readonly unknown[]> {
	return Array.isArray(input)
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

function createAssetCollector(
	input: Readonly<{
		limits: MarkdownRenderLimits
		signal: AbortSignal
	}>,
): Readonly<{
	sink: MarkdownAssetSink
	images: readonly GeneratedImage[]
	close(): void
}> {
	const images: GeneratedImage[] = []
	const prefix = INTERNAL_ASSET_PREFIX + crypto.randomUUID() + '/'
	const perAssetLimit = input.limits.maxAssetBytes
	const totalLimit = input.limits.maxTotalAssetBytes
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
			const { data: bytes, mediaType } = asset
			const byteLength = bytes.byteLength
			if (!isAssetMediaType(mediaType)) {
				throw new MarkdownError(
					'INVALID_INPUT',
					'Generated Markdown asset media type is unsupported',
				)
			}
			if (bytes.buffer instanceof SharedArrayBuffer || byteLength === 0) {
				throw new MarkdownError('INVALID_INPUT', 'Generated Markdown asset bytes are invalid')
			}
			if (images.length + pendingAssets >= input.limits.maxAssets) {
				throw new MarkdownError(
					'ASSET_COUNT_EXCEEDED',
					'Markdown extensions exceed the configured generated-asset limit',
				)
			}
			if (byteLength > perAssetLimit) {
				throw new MarkdownError(
					'ASSET_TOO_LARGE',
					'Generated Markdown asset exceeds the configured byte limit',
				)
			}
			if (byteLength > totalLimit - totalBytes - reservedBytes) {
				throw new MarkdownError(
					'ASSET_BYTES_EXCEEDED',
					'Generated Markdown assets exceed the configured byte limit',
				)
			}
			const source = prefix + nextAsset + mediaTypeSuffix(mediaType)
			nextAsset += 1
			pendingAssets += 1
			reservedBytes += byteLength
			try {
				const data = await copyBytes(bytes, input.signal)
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
				reservedBytes -= byteLength
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

async function yieldToEventLoop(signal: AbortSignal): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve))
	signal.throwIfAborted()
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
