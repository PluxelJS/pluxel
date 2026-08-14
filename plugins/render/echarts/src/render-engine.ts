import { AsyncLocalStorage } from 'node:async_hooks'
import * as echarts from 'echarts'
import type { EChartsOption, EChartsType, SetOptionOpts } from 'echarts'
import { EChartsError } from './errors.ts'
import type { EChartsTheme } from './index.ts'

const PLATFORM_STATE_KEY = Symbol.for('@pluxel/echarts.render-engine.v2')

export type RenderOutput = Readonly<{
	format: 'png' | 'jpeg' | 'webp'
	quality?: number
}>

export type RenderEngineInput = Readonly<{
	width: number
	height: number
	devicePixelRatio: number
	option: EChartsOption
	theme: string | EChartsTheme
	injectOptionFont: boolean
	defaultFontCssFamily: string
	fontRevision: number
	locale?: string
	setOption?: Readonly<SetOptionOpts>
	output: RenderOutput
	maxDataUrlBytes: number
}>

export type RenderEngineResult = Readonly<{
	data: Uint8Array
	mediaType: 'image/png' | 'image/jpeg' | 'image/webp'
	width: number
	height: number
	devicePixelRatio: number
}>

export interface RenderImage {
	onload: null | (() => void)
	onerror: null | ((cause: unknown) => void)
	src: unknown
}

export interface RenderContext2D {
	font: string
	measureText(text: string): TextMetrics
}

export interface RenderCanvas {
	getContext(kind: '2d'): RenderContext2D
	encode(format: 'png'): Promise<Uint8Array>
	encode(format: 'jpeg' | 'webp', quality?: number): Promise<Uint8Array>
}

export interface RenderCanvasAdapter {
	createCanvas(width: number, height: number): RenderCanvas
	createImage(): RenderImage
	decodeImage(
		data: Uint8Array,
		options: { signal: AbortSignal; dataOwnership: 'owned' },
	): Promise<RenderImage>
}

type RenderScope = {
	readonly canvas: RenderCanvasAdapter
	readonly defaultFontCssFamily: string
	readonly signal: AbortSignal
	readonly maxDataUrlBytes: number
	imageSources?: Map<string, Uint8Array>
	imageKeys?: Map<string, string>
	decodedImages?: Map<string, Promise<RenderImage>>
	readonly pendingImages: Set<Promise<void>>
	readonly renderId: number
	nextImageId: number
	measureContext?: RenderContext2D
}

type PlatformState = {
	readonly version: 2
	readonly storage: AsyncLocalStorage<RenderScope>
	nextRenderId: number
}

export type RenderInputOwnership = 'borrowed' | 'owned'

let cachedPlatformState: PlatformState | undefined

export function assertEChartsVersion(): void {
	if (!echarts.version.startsWith('6.')) {
		throw new EChartsError(
			'RENDER_FAILED',
			`@pluxel/echarts requires Apache ECharts 6.x; found ${echarts.version}`,
		)
	}
}

export async function renderECharts(
	input: RenderEngineInput,
	canvas: RenderCanvasAdapter,
	signal: AbortSignal,
	inputOwnership: RenderInputOwnership = 'borrowed',
): Promise<RenderEngineResult> {
	assertEChartsVersion()
	if (signal.aborted) throw abortReason(signal)
	const platformState = getPlatformState()
	const scope: RenderScope = {
		canvas,
		defaultFontCssFamily: input.defaultFontCssFamily,
		signal,
		maxDataUrlBytes: input.maxDataUrlBytes,
		pendingImages: new Set(),
		renderId: platformState.nextRenderId++,
		nextImageId: 0,
	}
	let chart: EChartsType | undefined
	try {
		const option =
			inputOwnership === 'owned'
				? rewriteDataUrlsInPlace(input.option, scope)
				: rewriteDataUrls(input.option, scope)
		// Rewriting is complete; keep decoded bytes, but do not retain large source strings during render.
		scope.imageKeys = undefined
		const optionWithFont = input.injectOptionFont
			? applyOptionDefaultFont(option, input.defaultFontCssFamily, inputOwnership)
			: option
		const physicalWidth = Math.ceil(input.width * input.devicePixelRatio)
		const physicalHeight = Math.ceil(input.height * input.devicePixelRatio)
		const root = canvas.createCanvas(physicalWidth, physicalHeight)
		const data = await platformState.storage.run(scope, async () => {
			chart = echarts.init(root as unknown as HTMLElement, input.theme, {
				renderer: 'canvas',
				ssr: true,
				width: input.width,
				height: input.height,
				devicePixelRatio: input.devicePixelRatio,
				...(input.locale === undefined ? {} : { locale: input.locale }),
			})
			chart.setOption(optionWithFont, input.setOption)
			await flushWithImages(chart, scope)
			const encoded =
				input.output.format === 'png'
					? root.encode('png')
					: root.encode(input.output.format, input.output.quality)
			return waitForSignal(encoded, signal)
		})
		return Object.freeze({
			data,
			mediaType: mediaTypeFor(input.output.format),
			width: input.width,
			height: input.height,
			devicePixelRatio: input.devicePixelRatio,
		})
	} catch (cause) {
		if (cause instanceof EChartsError) throw cause
		if (signal.aborted) throw abortReason(signal)
		throw new EChartsError('RENDER_FAILED', 'Apache ECharts server rendering failed', { cause })
	} finally {
		chart?.dispose()
	}
}

function getPlatformState(): PlatformState {
	if (cachedPlatformState) return cachedPlatformState
	const globalRecord = globalThis as unknown as Record<PropertyKey, unknown>
	const existing = globalRecord[PLATFORM_STATE_KEY]
	if (existing !== undefined) {
		if (
			!existing ||
			typeof existing !== 'object' ||
			(existing as Partial<PlatformState>).version !== 2 ||
			!((existing as Partial<PlatformState>).storage instanceof AsyncLocalStorage) ||
			typeof (existing as Partial<PlatformState>).nextRenderId !== 'number' ||
			!Number.isSafeInteger((existing as Partial<PlatformState>).nextRenderId)
		) {
			throw new EChartsError(
				'RENDER_FAILED',
				'Process-global @pluxel/echarts platform state is incompatible',
			)
		}
		cachedPlatformState = existing as PlatformState
		return cachedPlatformState
	}
	const state: PlatformState = Object.seal({
		version: 2,
		storage: new AsyncLocalStorage<RenderScope>(),
		nextRenderId: 0,
	})
	echarts.setPlatformAPI({
		createCanvas(width = 32, height = 32) {
			return requireRenderScope().canvas.createCanvas(width, height) as unknown as HTMLCanvasElement
		},
		measureText(text, font) {
			const scope = requireRenderScope()
			const context = (scope.measureContext ??= scope.canvas.createCanvas(1, 1).getContext('2d'))
			context.font = font || `12px ${scope.defaultFontCssFamily}`
			return context.measureText(text)
		},
		loadImage(src, onload, onerror) {
			const scope = requireRenderScope()
			const image = scope.canvas.createImage()
			const task = loadPlatformImage(scope, image, String(src), onload, onerror)
			scope.pendingImages.add(task)
			void task.then(
				() => scope.pendingImages.delete(task),
				() => scope.pendingImages.delete(task),
			)
			void task.catch((): void => undefined)
			return image as unknown as HTMLImageElement
		},
	})
	Object.defineProperty(globalThis, PLATFORM_STATE_KEY, {
		configurable: false,
		enumerable: false,
		value: state,
		writable: false,
	})
	cachedPlatformState = state
	return cachedPlatformState
}

function requireRenderScope(): RenderScope {
	const scope = (globalThis as unknown as Record<PropertyKey, PlatformState>)[
		PLATFORM_STATE_KEY
	]?.storage.getStore()
	if (!scope) {
		throw new EChartsError(
			'RENDER_FAILED',
			'ECharts platform resources are only available inside renderECharts()',
		)
	}
	return scope
}

async function loadPlatformImage(
	scope: RenderScope,
	image: RenderImage,
	src: string,
	onload: () => void,
	onerror: () => void,
): Promise<void> {
	let callbackInvoked = false
	try {
		const decoded = await decodePlatformImage(scope, src)
		await new Promise<void>((resolve, reject) => {
			image.onload = () => {
				callbackInvoked = true
				try {
					onload.call(image)
					resolve()
				} catch (cause) {
					reject(
						cause instanceof Error
							? cause
							: new EChartsError('IMAGE_LOAD_FAILED', 'ECharts image callback failed', {
									cause,
								}),
					)
				}
			}
			image.onerror = (cause) => {
				callbackInvoked = true
				try {
					onerror.call(image)
				} finally {
					reject(
						new EChartsError('IMAGE_LOAD_FAILED', 'Native image adapter rejected decoded bytes', {
							cause,
						}),
					)
				}
			}
			image.src = decoded.src
		})
	} catch (cause) {
		if (!callbackInvoked) {
			try {
				onerror.call(image)
			} catch {
				// Preserve the image failure as the public branch signal.
			}
		}
		if (cause instanceof EChartsError) throw cause
		throw new EChartsError('IMAGE_LOAD_FAILED', 'ECharts image loading failed', { cause })
	}
}

function decodePlatformImage(scope: RenderScope, source: string): Promise<RenderImage> {
	const decodedImages = (scope.decodedImages ??= new Map())
	const existing = decodedImages.get(source)
	if (existing) return existing
	const bytes = resolveImageSource(scope, source)
	scope.imageSources?.delete(source)
	const task = scope.canvas.decodeImage(bytes, {
		signal: scope.signal,
		dataOwnership: 'owned',
	})
	decodedImages.set(source, task)
	return task
}

async function flushWithImages(chart: EChartsType, scope: RenderScope): Promise<void> {
	for (let pass = 0; pass < 100; pass += 1) {
		if (scope.signal.aborted) throw abortReason(scope.signal)
		chart.getZr().flush()
		if (scope.pendingImages.size === 0) return
		await waitForSignal(Promise.all(scope.pendingImages), scope.signal)
	}
	throw new EChartsError('RENDER_FAILED', 'ECharts image loading did not settle after 100 passes')
}

function rewriteDataUrls(option: EChartsOption, scope: RenderScope): EChartsOption {
	const seen = new WeakMap<object, unknown>()
	return rewriteValue(option, scope, seen) as EChartsOption
}

function rewriteDataUrlsInPlace(option: EChartsOption, scope: RenderScope): EChartsOption {
	rewriteOwnedValue(option, scope, new WeakSet())
	return option
}

function rewriteOwnedValue(
	value: unknown,
	scope: RenderScope,
	seen: WeakSet<object>,
	property?: string,
): unknown {
	if (typeof value === 'string') {
		if (value.startsWith('image://data:')) return rewriteDataUrlString(value, scope)
		return property === 'image' && value.startsWith('data:')
			? rewriteDataUrlString(value, scope)
			: value
	}
	if (!value || typeof value !== 'object' || seen.has(value)) return value
	seen.add(value)
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index += 1) {
			value[index] = rewriteOwnedValue(value[index], scope, seen, property)
		}
		return value
	}
	if (!isPlainRecord(value)) return value
	for (const [key, item] of Object.entries(value)) {
		value[key] = rewriteOwnedValue(item, scope, seen, key)
	}
	return value
}

function rewriteValue(
	value: unknown,
	scope: RenderScope,
	seen: WeakMap<object, unknown>,
	property?: string,
): unknown {
	if (typeof value === 'string') {
		if (value.startsWith('image://data:')) return rewriteDataUrlString(value, scope)
		return property === 'image' && value.startsWith('data:')
			? rewriteDataUrlString(value, scope)
			: value
	}
	if (!value || typeof value !== 'object') return value
	const existing = seen.get(value)
	if (existing !== undefined) return existing
	if (Array.isArray(value)) {
		const result: unknown[] = []
		seen.set(value, result)
		for (const item of value) result.push(rewriteValue(item, scope, seen, property))
		return result
	}
	if (!isPlainRecord(value)) return value
	const result: Record<string, unknown> = {}
	seen.set(value, result)
	for (const [key, item] of Object.entries(value)) {
		Object.defineProperty(result, key, {
			configurable: true,
			enumerable: true,
			value: rewriteValue(item, scope, seen, key),
			writable: true,
		})
	}
	return result
}

function rewriteDataUrlString(value: string, scope: RenderScope): string {
	if (value.startsWith('data:')) return registerImageSource(scope, value)
	if (value.startsWith('image://data:')) {
		return `image://${registerImageSource(scope, value.slice('image://'.length))}`
	}
	return value
}

function registerImageSource(scope: RenderScope, source: string): string {
	const imageKeys = (scope.imageKeys ??= new Map())
	const existing = imageKeys.get(source)
	if (existing) return existing
	const bytes = decodeDataUrl(source, scope.maxDataUrlBytes)
	const key = `pluxel-image:${scope.renderId}:${scope.nextImageId++}`
	imageKeys.set(source, key)
	const imageSources = (scope.imageSources ??= new Map())
	imageSources.set(key, bytes)
	return key
}

function resolveImageSource(scope: RenderScope, source: string): Uint8Array {
	const registered = scope.imageSources?.get(source)
	if (registered) return registered
	if (source.startsWith('data:')) return decodeDataUrl(source, scope.maxDataUrlBytes)
	throw new EChartsError(
		'UNSUPPORTED_IMAGE_SOURCE',
		'ECharts server rendering accepts data URL strings; fetch remote images before render()',
	)
}

function decodeDataUrl(source: string, maxBytes: number): Uint8Array {
	if (source.length > maxBytes * 4 + 4_096) {
		throw new EChartsError(
			'IMAGE_SOURCE_TOO_LARGE',
			`Image data URL exceeds the configured ${maxBytes} byte limit`,
		)
	}
	const comma = source.indexOf(',')
	if (!source.startsWith('data:') || comma < 5) {
		throw new EChartsError('INVALID_IMAGE_SOURCE', 'Image source is not a valid data URL')
	}
	const metadata = source.slice(5, comma)
	const payload = source.slice(comma + 1)
	let bytes: Buffer
	try {
		const base64 = metadata
			.split(';')
			.some((token) => token.trim().toLocaleLowerCase('en-US') === 'base64')
		if (base64) {
			const compact = payload.replaceAll(/\s/gu, '')
			if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(compact) || compact.length % 4 === 1) {
				throw new TypeError('Invalid base64 payload')
			}
			bytes = Buffer.from(compact, 'base64')
		} else {
			bytes = decodePercentEncodedBytes(payload)
		}
	} catch (cause) {
		throw new EChartsError('INVALID_IMAGE_SOURCE', 'Image data URL payload is invalid', { cause })
	}
	if (bytes.byteLength <= 0) {
		throw new EChartsError('INVALID_IMAGE_SOURCE', 'Image data URL payload is empty')
	}
	if (bytes.byteLength > maxBytes) {
		throw new EChartsError(
			'IMAGE_SOURCE_TOO_LARGE',
			`Image data URL decodes to ${bytes.byteLength} bytes; the configured limit is ${maxBytes}`,
		)
	}
	return bytes
}

function decodePercentEncodedBytes(payload: string): Buffer {
	const source = Buffer.from(payload, 'utf8')
	const decoded = Buffer.allocUnsafe(source.byteLength)
	let writeOffset = 0
	for (let readOffset = 0; readOffset < source.byteLength; readOffset += 1) {
		const byte = source[readOffset]!
		if (byte !== 0x25) {
			decoded[writeOffset++] = byte
			continue
		}
		if (readOffset + 2 >= source.byteLength) throw new TypeError('Incomplete percent escape')
		const high = hexValue(source[readOffset + 1]!)
		const low = hexValue(source[readOffset + 2]!)
		if (high < 0 || low < 0) throw new TypeError('Invalid percent escape')
		decoded[writeOffset++] = high * 16 + low
		readOffset += 2
	}
	return decoded.subarray(0, writeOffset)
}

function hexValue(byte: number): number {
	if (byte >= 0x30 && byte <= 0x39) return byte - 0x30
	if (byte >= 0x41 && byte <= 0x46) return byte - 0x41 + 10
	if (byte >= 0x61 && byte <= 0x66) return byte - 0x61 + 10
	return -1
}

function applyOptionDefaultFont(
	option: EChartsOption,
	cssFamily: string,
	inputOwnership: RenderInputOwnership,
): EChartsOption {
	const record = option as unknown as Record<string, unknown>
	const textStyle = isPlainRecord(record.textStyle) ? record.textStyle : {}
	if (typeof textStyle.fontFamily === 'string' && textStyle.fontFamily.trim()) return option
	if (inputOwnership === 'owned') {
		record.textStyle = { fontFamily: cssFamily, ...textStyle }
		return option
	}
	return { ...option, textStyle: { fontFamily: cssFamily, ...textStyle } }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false
	const prototype = Object.getPrototypeOf(value) as unknown
	return prototype === Object.prototype || prototype === null
}

function mediaTypeFor(format: RenderOutput['format']): RenderEngineResult['mediaType'] {
	return format === 'png' ? 'image/png' : format === 'jpeg' ? 'image/jpeg' : 'image/webp'
}

async function waitForSignal<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) throw abortReason(signal)
	let rejectAbort!: (reason: Error) => void
	const aborted = new Promise<never>((_resolve, reject) => void (rejectAbort = reject))
	const listener = () => rejectAbort(abortReason(signal))
	signal.addEventListener('abort', listener, { once: true })
	try {
		return await Promise.race([task, aborted])
	} finally {
		signal.removeEventListener('abort', listener)
	}
}

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error
		? signal.reason
		: new DOMException('ECharts rendering aborted', 'AbortError')
}
