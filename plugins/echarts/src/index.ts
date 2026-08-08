import { AsyncLocalStorage } from 'node:async_hooks'
import { CanvasError, CanvasPlugin, type Image, type SKRSContext2D } from '@pluxel/canvas'
import { FontsPlugin, type DefaultFontSnapshot } from '@pluxel/fonts'
import { FontsSelectionPort } from '@pluxel/fonts/workbench'
import { BasePlugin, Plugin, type Context } from '@pluxel/runtime'
import { workbench } from '@pluxel/runtime/workbench'
import { workbenchContract } from '@pluxel/runtime/workbench/contract'
import * as echarts from 'echarts'
import type { EChartsOption, EChartsType, SetOptionOpts } from 'echarts'
import { EChartsConfig, type EChartsPluginConfig } from './config.ts'

const MAX_THEME_NAME_LENGTH = 128
const MAX_THEME_DEPTH = 64
const PLATFORM_STATE_KEY = Symbol.for('@pluxel/echarts.platform-state.v1')
const BUILTIN_THEMES = new Set(['default', 'dark'])

const EChartsWorkbench = workbench.portOutlet({
	id: 'Fonts',
	port: FontsSelectionPort,
	placement: workbenchContract.tab({
		label: 'Fonts',
		icon: workbenchContract.icons.Typography,
	}),
})

export type EChartsThemeValue =
	| null
	| boolean
	| number
	| string
	| readonly EChartsThemeValue[]
	| Readonly<{ [key: string]: EChartsThemeValue }>

export type EChartsTheme = Readonly<{ [key: string]: EChartsThemeValue }>

export type EChartsThemeRegistrationInput = Readonly<{
	name: string
	theme: EChartsTheme
}>

export type EChartsThemeSnapshot = Readonly<{
	name: string
	byteLength: number
}>

export interface EChartsThemeRegistration {
	readonly name: string
	readonly active: boolean
	/** Removes this caller-owned name. Repeated calls are harmless. */
	dispose(): void
}

export type EChartsRasterOutput =
	| Readonly<{
			/** @defaultValue 'png' */
			format?: 'png'
			quality?: never
	  }>
	| Readonly<{
			format: 'jpeg' | 'webp'
			/** Encoder quality from 0 through 100. Omission uses the native encoder default. */
			quality?: number
	  }>

export type EChartsRenderInput = Readonly<{
	width: number
	height: number
	option: EChartsOption
	/** Caller-owned registered name, built-in `default`/`dark`, or an inline JSON theme. */
	theme?: string | EChartsTheme
	/** Uses the plugin's configured default when omitted. */
	devicePixelRatio?: number
	/** ECharts built-in locale name. */
	locale?: string
	setOption?: Readonly<SetOptionOpts>
	output?: EChartsRasterOutput
	signal?: AbortSignal
}>

export type EChartsRenderResult = Readonly<{
	data: Buffer
	mediaType: 'image/png' | 'image/jpeg' | 'image/webp'
	width: number
	height: number
	devicePixelRatio: number
}>

export type EChartsErrorCode =
	| 'NOT_RUNNING'
	| 'INVALID_INPUT'
	| 'INVALID_THEME'
	| 'THEME_TOO_LARGE'
	| 'THEME_LIMIT_EXCEEDED'
	| 'THEME_CONFLICT'
	| 'THEME_NOT_FOUND'
	| 'INVALID_IMAGE_SOURCE'
	| 'IMAGE_SOURCE_TOO_LARGE'
	| 'UNSUPPORTED_IMAGE_SOURCE'
	| 'IMAGE_LOAD_FAILED'
	| 'RENDER_FAILED'

export class EChartsError extends Error {
	override readonly name = 'EChartsError'

	constructor(
		readonly code: EChartsErrorCode,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options)
	}
}

type NormalizedTheme = Readonly<{
	value: EChartsTheme
	byteLength: number
}>

type OwnedTheme = Readonly<{
	theme: NormalizedTheme
	handle: ThemeRegistrationHandle
}>

type EChartsLease = {
	readonly owner: Context
	readonly generation: object
	readonly controller: AbortController
	readonly themes: Map<string, OwnedTheme>
	active: boolean
}

type RenderScope = {
	readonly canvas: CanvasPlugin
	readonly defaultFont: DefaultFontSnapshot
	readonly signal: AbortSignal
	readonly maxDataUrlBytes: number
	readonly imageSources: Map<string, Uint8Array>
	readonly imageKeys: Map<string, string>
	readonly pendingImages: Set<Promise<void>>
	readonly renderId: number
	nextImageId: number
	measureContext?: SKRSContext2D
}

type PlatformState = {
	readonly version: 1
	readonly storage: AsyncLocalStorage<RenderScope>
	nextRenderId: number
}

@Plugin({ name: 'EChartsPlugin' })
export class EChartsPlugin extends BasePlugin {
	private readonly config = this.configs.use(EChartsConfig)
	private readonly leases = new Set<EChartsLease>()
	private readonly leasesByOwner = new WeakMap<Context, EChartsLease>()
	private generation?: object

	constructor(
		private readonly canvas: CanvasPlugin,
		private readonly fonts: FontsPlugin,
	) {
		super()
	}

	override async init(): Promise<void> {
		if (!echarts.version.startsWith('6.')) {
			throw new EChartsError(
				'RENDER_FAILED',
				`@pluxel/echarts requires Apache ECharts 6.x; found ${echarts.version}`,
			)
		}
		if (this.config.defaultDevicePixelRatio > this.config.maxDevicePixelRatio) {
			throw new EChartsError(
				'INVALID_INPUT',
				'defaultDevicePixelRatio must not exceed maxDevicePixelRatio',
			)
		}
		installPlatformApi()
		const generation = Object.freeze({})
		this.generation = generation
		this.ctx.effects.defer(
			() => {
				if (this.generation === generation) this.generation = undefined
				for (const lease of this.leases) this.closeLease(lease)
			},
			{ tag: 'echarts-generation' },
		)
		this.ctx.workbench.mount(EChartsWorkbench, {
			selection: workbench.bind.rpc(() => this.fonts.selectionManager()),
		})
	}

	/** Current provider-wide family applied when neither option nor theme chooses one. */
	get defaultFont(): DefaultFontSnapshot {
		this.requireLease()
		return this.fonts.defaultFont
	}

	/** Detached snapshot of caller-owned named themes. */
	get themes(): readonly EChartsThemeSnapshot[] {
		const lease = this.requireLease()
		return Object.freeze(
			[...lease.themes.entries()]
				.map(([name, entry]) => Object.freeze({ name, byteLength: entry.theme.byteLength }))
				.toSorted((left, right) => left.name.localeCompare(right.name)),
		)
	}

	/**
	 * Registers a theme under the current caller instead of ECharts' irreversible global registry.
	 * The name is automatically removed with the caller generation.
	 */
	registerTheme(input: EChartsThemeRegistrationInput): EChartsThemeRegistration {
		const lease = this.requireLease()
		if (!input || typeof input !== 'object') {
			throw new EChartsError('INVALID_THEME', 'registerTheme() requires an input object')
		}
		const name = normalizeThemeName(input.name)
		if (lease.themes.has(name)) {
			throw new EChartsError(
				'THEME_CONFLICT',
				`Theme "${name}" is already registered by this caller`,
			)
		}
		if (lease.themes.size >= this.config.maxThemesPerConsumer) {
			throw new EChartsError(
				'THEME_LIMIT_EXCEEDED',
				`Theme owner reached its ${this.config.maxThemesPerConsumer} theme limit`,
			)
		}
		const theme = normalizeTheme(input.theme, this.config.maxThemeBytes)
		let owned!: OwnedTheme
		const handle = new ThemeRegistrationHandle(name, () => {
			if (lease.themes.get(name) !== owned) return
			lease.themes.delete(name)
			handle.deactivate()
		})
		owned = Object.freeze({ theme, handle })
		lease.themes.set(name, owned)
		return handle
	}

	/**
	 * Renders one ECharts option into a bounded caller-owned Canvas and always disposes the chart.
	 * Data URL images are decoded through CanvasPlugin; network and file image sources are rejected.
	 */
	async render(input: EChartsRenderInput): Promise<EChartsRenderResult> {
		const lease = this.requireLease()
		const normalized = this.normalizeRenderInput(input)
		const abortLink = linkAbortSignals([lease.controller.signal, input.signal])
		if (abortLink.signal.aborted) {
			abortLink.dispose()
			throw abortReason(abortLink.signal)
		}
		const platformState = getPlatformState()
		const scope: RenderScope = {
			canvas: this.canvas,
			defaultFont: this.fonts.defaultFont,
			signal: abortLink.signal,
			maxDataUrlBytes: this.config.maxDataUrlBytes,
			imageSources: new Map(),
			imageKeys: new Map(),
			pendingImages: new Set(),
			renderId: platformState.nextRenderId++,
			nextImageId: 0,
		}
		let chart: EChartsType | undefined
		try {
			const option = rewriteDataUrls(normalized.option, scope)
			const resolvedTheme = this.resolveTheme(lease, normalized.theme, scope.defaultFont)
			const optionWithFont = resolvedTheme.injectOptionFont
				? applyOptionDefaultFont(option, scope.defaultFont.cssFamily)
				: option
			const physicalWidth = Math.ceil(normalized.width * normalized.devicePixelRatio)
			const physicalHeight = Math.ceil(normalized.height * normalized.devicePixelRatio)
			const root = this.canvas.createCanvas(physicalWidth, physicalHeight)

			const data = await platformState.storage.run(scope, async () => {
				chart = echarts.init(root as unknown as HTMLElement, resolvedTheme.value, {
					renderer: 'canvas',
					ssr: true,
					width: normalized.width,
					height: normalized.height,
					devicePixelRatio: normalized.devicePixelRatio,
					...(normalized.locale === undefined ? {} : { locale: normalized.locale }),
				})
				chart.setOption(optionWithFont, normalized.setOption)
				await flushWithImages(chart, scope)
				const encoded =
					normalized.output.format === 'png'
						? root.encode('png')
						: root.encode(normalized.output.format, normalized.output.quality)
				return waitForSignal(encoded, scope.signal)
			})
			return Object.freeze({
				data,
				mediaType: mediaTypeFor(normalized.output.format),
				width: normalized.width,
				height: normalized.height,
				devicePixelRatio: normalized.devicePixelRatio,
			})
		} catch (cause) {
			if (cause instanceof EChartsError) throw cause
			if (abortLink.signal.aborted) throw abortReason(abortLink.signal)
			throw new EChartsError('RENDER_FAILED', 'Apache ECharts server rendering failed', { cause })
		} finally {
			chart?.dispose()
			abortLink.dispose()
		}
	}

	private resolveTheme(
		lease: EChartsLease,
		theme: string | EChartsTheme | undefined,
		defaultFont: DefaultFontSnapshot,
	): Readonly<{ value: string | EChartsTheme; injectOptionFont: boolean }> {
		if (theme === undefined) {
			return Object.freeze({
				value: themeWithDefaultFont(Object.freeze({}), defaultFont.cssFamily),
				injectOptionFont: false,
			})
		}
		if (typeof theme === 'string') {
			const name = normalizeThemeName(theme)
			const registered = lease.themes.get(name)
			if (registered) {
				return Object.freeze({
					value: themeWithDefaultFont(registered.theme.value, defaultFont.cssFamily),
					injectOptionFont: false,
				})
			}
			if (BUILTIN_THEMES.has(name)) {
				return Object.freeze({ value: name, injectOptionFont: true })
			}
			throw new EChartsError('THEME_NOT_FOUND', `Theme "${name}" is not registered by this caller`)
		}
		const normalized = normalizeTheme(theme, this.config.maxThemeBytes)
		return Object.freeze({
			value: themeWithDefaultFont(normalized.value, defaultFont.cssFamily),
			injectOptionFont: false,
		})
	}

	private normalizeRenderInput(input: EChartsRenderInput): Readonly<{
		width: number
		height: number
		devicePixelRatio: number
		option: EChartsOption
		theme?: string | EChartsTheme
		locale?: string
		setOption?: Readonly<SetOptionOpts>
		output: Readonly<{ format: 'png' | 'jpeg' | 'webp'; quality?: number }>
	}> {
		if (!input || typeof input !== 'object') {
			throw new EChartsError('INVALID_INPUT', 'render() requires an input object')
		}
		if (!Number.isSafeInteger(input.width) || !Number.isSafeInteger(input.height)) {
			throw new EChartsError('INVALID_INPUT', 'Render width and height must be integers')
		}
		if (input.width <= 0 || input.height <= 0) {
			throw new EChartsError('INVALID_INPUT', 'Render width and height must be positive')
		}
		if (!input.option || typeof input.option !== 'object' || Array.isArray(input.option)) {
			throw new EChartsError('INVALID_INPUT', 'render() requires an ECharts option object')
		}
		const devicePixelRatio = input.devicePixelRatio ?? this.config.defaultDevicePixelRatio
		if (
			!Number.isFinite(devicePixelRatio) ||
			devicePixelRatio <= 0 ||
			devicePixelRatio > this.config.maxDevicePixelRatio
		) {
			throw new EChartsError(
				'INVALID_INPUT',
				`devicePixelRatio must be greater than 0 and at most ${this.config.maxDevicePixelRatio}`,
			)
		}
		if (
			input.locale !== undefined &&
			(typeof input.locale !== 'string' ||
				!input.locale.trim() ||
				input.locale.length > 128 ||
				hasControlCharacters(input.locale))
		) {
			throw new EChartsError('INVALID_INPUT', 'locale must be a valid ECharts locale name')
		}
		const output = normalizeOutput(input.output)
		return Object.freeze({
			width: input.width,
			height: input.height,
			devicePixelRatio,
			option: input.option,
			...(input.theme === undefined ? {} : { theme: input.theme }),
			...(input.locale === undefined ? {} : { locale: input.locale.trim() }),
			...(input.setOption === undefined ? {} : { setOption: input.setOption }),
			output,
		})
	}

	private requireLease(): EChartsLease {
		const generation = this.generation
		if (!generation) throw new EChartsError('NOT_RUNNING', 'EChartsPlugin is not running')
		const owner = this.ctx.caller ?? this.ctx
		const existing = this.leasesByOwner.get(owner)
		if (existing) {
			if (!existing.active || existing.generation !== generation) {
				throw new EChartsError(
					'NOT_RUNNING',
					'ECharts capability belongs to a stopped plugin generation',
				)
			}
			return existing
		}
		const lease: EChartsLease = {
			owner,
			generation,
			controller: new AbortController(),
			themes: new Map(),
			active: true,
		}
		this.leases.add(lease)
		this.leasesByOwner.set(owner, lease)
		try {
			owner.effects.defer(() => this.closeLease(lease), { tag: 'echarts-caller' })
		} catch (cause) {
			this.closeLease(lease)
			throw new EChartsError('NOT_RUNNING', 'ECharts caller is stopped or being replaced', {
				cause,
			})
		}
		return lease
	}

	private closeLease(lease: EChartsLease): void {
		if (!lease.active) return
		lease.active = false
		lease.controller.abort(
			new EChartsError('NOT_RUNNING', 'ECharts capability belongs to a stopped plugin generation'),
		)
		for (const { handle } of lease.themes.values()) handle.deactivate()
		lease.themes.clear()
		this.leases.delete(lease)
		if (this.leasesByOwner.get(lease.owner) === lease) this.leasesByOwner.delete(lease.owner)
	}
}

class ThemeRegistrationHandle implements EChartsThemeRegistration {
	active = true

	constructor(
		readonly name: string,
		private readonly release: () => void,
	) {}

	dispose(): void {
		this.release()
	}

	deactivate(): void {
		this.active = false
	}
}

function installPlatformApi(): void {
	getPlatformState()
	echarts.setPlatformAPI({
		createCanvas(width = 32, height = 32) {
			const scope = requireRenderScope()
			return scope.canvas.createCanvas(width, height) as unknown as HTMLCanvasElement
		},
		measureText(text, font) {
			const scope = requireRenderScope()
			const context = (scope.measureContext ??= scope.canvas.createCanvas(1, 1).getContext('2d'))
			context.font = font || `12px ${scope.defaultFont.cssFamily}`
			return context.measureText(text)
		},
		loadImage(src, onload, onerror) {
			const scope = requireRenderScope()
			const image = scope.canvas.createImage()
			const task = loadPlatformImage(scope, image, src, onload, onerror)
			scope.pendingImages.add(task)
			void task.then(
				() => scope.pendingImages.delete(task),
				() => scope.pendingImages.delete(task),
			)
			void task.catch((): void => undefined)
			return image as unknown as HTMLImageElement
		},
	})
}

function requireRenderScope(): RenderScope {
	const scope = getPlatformState().storage.getStore()
	if (!scope) {
		throw new EChartsError(
			'RENDER_FAILED',
			'ECharts platform resources are only available inside EChartsPlugin.render()',
		)
	}
	return scope
}

function getPlatformState(): PlatformState {
	const globalRecord = globalThis as unknown as Record<PropertyKey, unknown>
	const existing = globalRecord[PLATFORM_STATE_KEY]
	if (existing !== undefined) {
		if (
			!existing ||
			typeof existing !== 'object' ||
			(existing as Partial<PlatformState>).version !== 1 ||
			!((existing as Partial<PlatformState>).storage instanceof AsyncLocalStorage) ||
			typeof (existing as Partial<PlatformState>).nextRenderId !== 'number' ||
			!Number.isSafeInteger((existing as Partial<PlatformState>).nextRenderId)
		) {
			throw new EChartsError(
				'RENDER_FAILED',
				'Process-global @pluxel/echarts platform state is incompatible',
			)
		}
		return existing as PlatformState
	}
	const state: PlatformState = Object.seal({
		version: 1,
		storage: new AsyncLocalStorage<RenderScope>(),
		nextRenderId: 0,
	})
	Object.defineProperty(globalThis, PLATFORM_STATE_KEY, {
		configurable: false,
		enumerable: false,
		value: state,
		writable: false,
	})
	return state
}

async function loadPlatformImage(
	scope: RenderScope,
	image: Image,
	src: string,
	onload: () => void,
	onerror: () => void,
): Promise<void> {
	let callbackInvoked = false
	try {
		const bytes = resolveImageSource(scope, src)
		const decoded = await scope.canvas.decodeImage(bytes, { signal: scope.signal })
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
		if (cause instanceof CanvasError) {
			throw new EChartsError('IMAGE_LOAD_FAILED', 'CanvasPlugin rejected an ECharts image', {
				cause,
			})
		}
		throw new EChartsError('IMAGE_LOAD_FAILED', 'ECharts image loading failed', { cause })
	}
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
	const existing = scope.imageKeys.get(source)
	if (existing) return existing
	const bytes = decodeDataUrl(source, scope.maxDataUrlBytes)
	const key = `pluxel-image:${scope.renderId}:${scope.nextImageId++}`
	scope.imageKeys.set(source, key)
	scope.imageSources.set(key, bytes)
	return key
}

function resolveImageSource(scope: RenderScope, source: string): Uint8Array {
	const registered = scope.imageSources.get(source)
	if (registered) return registered
	if (source.startsWith('data:')) return decodeDataUrl(source, scope.maxDataUrlBytes)
	throw new EChartsError(
		'UNSUPPORTED_IMAGE_SOURCE',
		'ECharts server rendering accepts data URL strings or caller-decoded Image objects; fetch remote images before render()',
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

function normalizeThemeName(value: unknown): string {
	if (typeof value !== 'string') throw new EChartsError('INVALID_THEME', 'Theme name must be text')
	const name = value.trim()
	if (!name || name.length > MAX_THEME_NAME_LENGTH || hasControlCharacters(name)) {
		throw new EChartsError('INVALID_THEME', 'Theme name is empty or invalid')
	}
	return name
}

function normalizeTheme(value: unknown, maxBytes: number): NormalizedTheme {
	if (!isPlainRecord(value)) {
		throw new EChartsError('INVALID_THEME', 'Theme must be a plain JSON object')
	}
	const seen = new WeakSet<object>()
	const normalized = cloneThemeValue(value, seen, 0) as EChartsTheme
	const byteLength = Buffer.byteLength(JSON.stringify(normalized), 'utf8')
	if (byteLength > maxBytes) {
		throw new EChartsError(
			'THEME_TOO_LARGE',
			`Theme is ${byteLength} bytes; the configured limit is ${maxBytes}`,
		)
	}
	return Object.freeze({ value: deepFreeze(normalized), byteLength })
}

function cloneThemeValue(value: unknown, seen: WeakSet<object>, depth: number): EChartsThemeValue {
	if (depth > MAX_THEME_DEPTH) {
		throw new EChartsError('INVALID_THEME', `Theme nesting exceeds ${MAX_THEME_DEPTH} levels`)
	}
	if (value === null) return null
	if (typeof value === 'string' || typeof value === 'boolean') return value
	if (typeof value === 'number') {
		if (!Number.isFinite(value))
			throw new EChartsError('INVALID_THEME', 'Theme numbers must be finite')
		return value
	}
	if (!value || typeof value !== 'object') {
		throw new EChartsError('INVALID_THEME', 'Theme values must be JSON-compatible')
	}
	if (seen.has(value)) throw new EChartsError('INVALID_THEME', 'Theme must not contain cycles')
	seen.add(value)
	try {
		if (Array.isArray(value)) {
			return value.map((item) => cloneThemeValue(item, seen, depth + 1))
		}
		if (!isPlainRecord(value)) {
			throw new EChartsError('INVALID_THEME', 'Theme values must use plain objects and arrays')
		}
		const result: Record<string, EChartsThemeValue> = {}
		for (const [key, item] of Object.entries(value)) {
			Object.defineProperty(result, key, {
				configurable: true,
				enumerable: true,
				value: cloneThemeValue(item, seen, depth + 1),
				writable: true,
			})
		}
		return result
	} finally {
		seen.delete(value)
	}
}

function themeWithDefaultFont(theme: EChartsTheme, cssFamily: string): EChartsTheme {
	const textStyle = isPlainRecord(theme.textStyle) ? theme.textStyle : {}
	if (typeof textStyle.fontFamily === 'string' && textStyle.fontFamily.trim()) return theme
	return Object.freeze({
		...theme,
		textStyle: Object.freeze({ fontFamily: cssFamily, ...textStyle }),
	})
}

function applyOptionDefaultFont(option: EChartsOption, cssFamily: string): EChartsOption {
	const record = option as unknown as Record<string, unknown>
	const textStyle = isPlainRecord(record.textStyle) ? record.textStyle : {}
	if (typeof textStyle.fontFamily === 'string' && textStyle.fontFamily.trim()) return option
	return {
		...option,
		textStyle: { fontFamily: cssFamily, ...textStyle },
	}
}

function deepFreeze<T>(value: T): T {
	if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
	for (const item of Object.values(value)) deepFreeze(item)
	return Object.freeze(value)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false
	const prototype = Object.getPrototypeOf(value) as unknown
	return prototype === Object.prototype || prototype === null
}

function normalizeOutput(
	output: EChartsRasterOutput | undefined,
): Readonly<{ format: 'png' | 'jpeg' | 'webp'; quality?: number }> {
	if (output !== undefined && (!output || typeof output !== 'object' || Array.isArray(output))) {
		throw new EChartsError('INVALID_INPUT', 'output must be an object')
	}
	const format = output?.format ?? 'png'
	if (format !== 'png' && format !== 'jpeg' && format !== 'webp') {
		throw new EChartsError('INVALID_INPUT', 'Output format must be png, jpeg, or webp')
	}
	if (format === 'png') {
		if (output && 'quality' in output && output.quality !== undefined) {
			throw new EChartsError('INVALID_INPUT', 'PNG output does not accept quality')
		}
		return Object.freeze({ format })
	}
	const quality = output?.quality
	if (quality !== undefined && (!Number.isFinite(quality) || quality < 0 || quality > 100)) {
		throw new EChartsError('INVALID_INPUT', 'Output quality must be between 0 and 100')
	}
	return Object.freeze({ format, ...(quality === undefined ? {} : { quality }) })
}

function mediaTypeFor(format: 'png' | 'jpeg' | 'webp'): EChartsRenderResult['mediaType'] {
	return format === 'png' ? 'image/png' : format === 'jpeg' ? 'image/jpeg' : 'image/webp'
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

async function waitForSignal<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) throw abortReason(signal)
	let rejectAbort!: (reason: Error) => void
	const aborted = new Promise<never>((_resolve, reject) => {
		rejectAbort = reject
	})
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

function hasControlCharacters(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index)
		if (code <= 0x1f || code === 0x7f) return true
	}
	return false
}

export { EChartsConfig }
export type { EChartsOption, EChartsPluginConfig, SetOptionOpts }
