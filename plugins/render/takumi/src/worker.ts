import { isMainThread } from 'node:worker_threads'
import { Renderer } from '@takumi-rs/core'
import { prepareImages, type Node, type CssInput } from '@takumi-rs/helpers'
import { extractEmojis } from '@takumi-rs/helpers/emoji'
import { fromHtml } from '@takumi-rs/helpers/html'
import { fromJsx } from '@takumi-rs/helpers/jsx'
import type {
	AnimationScene,
	Font,
	RenderAnimationOptions,
	RenderInput,
	RenderOptions,
	RenderSvgOptions,
} from 'takumi-js'
import { getWorkerRenderer } from './renderer-cache.ts'

type OmitEach<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
type Extras = { fonts?: readonly Font[]; renderer?: never; module?: never; stylesheets?: never }
/** JSX, callbacks and React hooks are local to this worker task's bundle. */
export type LocalRenderOptions = OmitEach<
	RenderOptions,
	'renderer' | 'module' | 'fonts' | 'stylesheets'
> &
	Extras
export type LocalSvgRenderOptions = OmitEach<
	RenderSvgOptions,
	'renderer' | 'module' | 'fonts' | 'stylesheets'
> &
	Extras
export type LocalAnimationOptions = OmitEach<
	RenderAnimationOptions,
	'renderer' | 'module' | 'fonts' | 'stylesheets'
> &
	Extras

type ContentOptions = Pick<LocalRenderOptions, 'emoji' | 'jsx' | 'signal' | 'images' | 'css'>

function assertWorker(options?: Extras): void {
	if (isMainThread)
		throw new Error('@pluxel/plugin-takumi/worker must execute inside a Worker task')
	if (
		options?.renderer !== undefined ||
		options?.module !== undefined ||
		options?.stylesheets !== undefined
	)
		throw new TypeError('Worker rendering owns its renderer and uses css for styles')
}

async function content(input: RenderInput, options?: ContentOptions) {
	const result =
		typeof input === 'string'
			? fromHtml(input)
			: input &&
				  typeof input === 'object' &&
				  'type' in input &&
				  (input.type === 'container' || input.type === 'text' || input.type === 'image')
				? { node: input as Node, css: [] as CssInput[] }
				: await fromJsx(input as Parameters<typeof fromJsx>[0], options?.jsx)
	return {
		node:
			options?.emoji === 'from-font'
				? result.node
				: extractEmojis(result.node, options?.emoji ?? 'twemoji'),
		css: result.css,
	}
}

async function images(node: Node | Node[], options?: ContentOptions) {
	const value = options?.images
	const { sources, cache, ...fetchOptions } = Array.isArray(value)
		? { sources: value }
		: (value ?? {})
	const prepared = await prepareImages({ node, sources, ...fetchOptions, signal: options?.signal })
	return cache
		? prepared.map((image) => ({
				...image,
				cache: ('cache' in image ? image.cache : undefined) ?? cache,
			}))
		: prepared
}

function css(value: ContentOptions['css'], extracted: CssInput[]): CssInput[] {
	return [...(value === undefined ? [] : Array.isArray(value) ? value : [value]), ...extracted]
}

/** Render inside a shared Worker, reusing its bounded native/font-set cache. */
export async function render(
	input: RenderInput,
	options: LocalRenderOptions = {},
): Promise<Buffer> {
	assertWorker(options)
	options.signal?.throwIfAborted()
	const resolved = await content(input, options)
	const preparedImages = await images(resolved.node, options)
	options.signal?.throwIfAborted()
	const cached = getWorkerRenderer(Renderer, options.fonts)
	return cached.renderer.render(resolved.node, {
		...options,
		fonts: cached.fonts,
		images: preparedImages,
		css: css(options.css, resolved.css),
	})
}

export async function renderSvg(
	input: RenderInput,
	options: LocalSvgRenderOptions = {},
): Promise<string> {
	assertWorker(options)
	options.signal?.throwIfAborted()
	const resolved = await content(input, options)
	const preparedImages = await images(resolved.node, options)
	options.signal?.throwIfAborted()
	const cached = getWorkerRenderer(Renderer, options.fonts)
	return cached.renderer.renderSvg(resolved.node, {
		...options,
		fonts: cached.fonts,
		images: preparedImages,
		css: css(options.css, resolved.css),
	})
}

export async function renderAnimation(options: LocalAnimationOptions): Promise<Buffer> {
	assertWorker(options)
	options.signal?.throwIfAborted()
	const scenes = await Promise.all(
		options.scenes.map(async (scene: AnimationScene) => ({
			...(await content(scene.node, options)),
			durationMs: scene.durationMs,
		})),
	)
	const preparedImages = await images(
		scenes.map((scene) => scene.node),
		options,
	)
	options.signal?.throwIfAborted()
	const cached = getWorkerRenderer(Renderer, options.fonts)
	return cached.renderer.renderAnimation({
		...options,
		fonts: cached.fonts,
		scenes: scenes.map(({ node, durationMs }) => ({ node, durationMs })),
		images: preparedImages,
		css: css(
			options.css,
			scenes.flatMap((scene) => scene.css),
		),
	})
}
