import { CanvasPlugin, type CanvasWorkerSnapshot } from '@pluxel/canvas'
import { FontsPlugin, type DefaultFontSnapshot } from '@pluxel/fonts'
import { FontsSelectionPort } from '@pluxel/fonts/workbench'
import {
	BasePlugin,
	defineWorkerTask,
	Plugin,
	type Context,
	WorkerTaskError,
} from '@pluxel/runtime'
import { workbench } from '@pluxel/runtime/workbench'
import { workbenchContract } from '@pluxel/runtime/workbench/contract'
import type { EChartsOption, SetOptionOpts } from 'echarts'
import { EChartsConfig, type EChartsPluginConfig } from './config.ts'
import { EChartsError, type EChartsErrorCode } from './errors.ts'
import {
	assertEChartsVersion,
	renderECharts,
	type RenderCanvasAdapter,
	type RenderEngineInput,
	type RenderEngineResult,
} from './render-engine.ts'
import type { EChartsWorkerInput, EChartsWorkerOutput } from './worker.ts'

const MAX_THEME_NAME_LENGTH = 128
const MAX_THEME_DEPTH = 64
const BUILTIN_THEMES = new Set(['default', 'dark'])
const EMPTY_THEME: EChartsTheme = Object.freeze({})

const renderTask = defineWorkerTask<EChartsWorkerInput, EChartsWorkerOutput>(
	import.meta.url,
	'./worker.ts',
)

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
	/** Read without mutation; worker execution additionally requires structured-clone-compatible values. */
	option: EChartsOption
	/** Caller-owned registered name, built-in `default`/`dark`, or an inline JSON theme. Omission uses the default-font base theme. */
	theme?: string | EChartsTheme
	/** Uses the plugin's configured default when omitted. */
	devicePixelRatio?: number
	/** ECharts built-in locale name. Omission uses ECharts' default locale. */
	locale?: string
	/** Omission uses ECharts' `setOption()` defaults. */
	setOption?: Readonly<SetOptionOpts>
	/** Raster encoding policy. Omission produces PNG. */
	output?: EChartsRasterOutput
	/** Worker is bounded and non-blocking; inline supports functions/native objects. @defaultValue 'worker' */
	execution?: 'worker' | 'inline'
	/** Cancels admission or worker execution; inline mode observes cancellation at renderer checkpoints. */
	signal?: AbortSignal
}>

export type EChartsRenderResult = Readonly<{
	/** Caller-owned encoded bytes detached from the worker result. */
	data: Buffer
	mediaType: 'image/png' | 'image/jpeg' | 'image/webp'
	width: number
	height: number
	devicePixelRatio: number
}>

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

type NormalizedRenderInput = Readonly<{
	width: number
	height: number
	devicePixelRatio: number
	option: EChartsOption
	theme?: string | EChartsTheme
	locale?: string
	setOption?: Readonly<SetOptionOpts>
	output: Readonly<{ format: 'png' | 'jpeg' | 'webp'; quality?: number }>
	execution: 'worker' | 'inline'
}>

@Plugin()
export class EChartsPlugin extends BasePlugin {
	private readonly config = this.configs.use(EChartsConfig)
	private readonly themeFontCache = new WeakMap<
		EChartsTheme,
		Readonly<{ cssFamily: string; value: EChartsTheme }>
	>()
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
		assertEChartsVersion()
		if (this.config.defaultDevicePixelRatio > this.config.maxDevicePixelRatio) {
			throw new EChartsError(
				'INVALID_INPUT',
				'defaultDevicePixelRatio must not exceed maxDevicePixelRatio',
			)
		}
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

	/** Register an immutable JSON theme until the current caller generation stops. */
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

	/** Render through the shared worker pool by default, or explicitly inline for non-cloneable options. */
	async render(input: EChartsRenderInput): Promise<EChartsRenderResult> {
		const lease = this.requireLease()
		const normalized = this.normalizeRenderInput(input)
		const abortLink = linkAbortSignals([lease.controller.signal, input.signal])
		try {
			if (abortLink.signal.aborted) throw abortReason(abortLink.signal)
			const canvasSnapshot = this.canvas.workerSnapshot
			const fontRevision = canvasSnapshot.font.revision
			const defaultFontCssFamily = rendererFontFamily(canvasSnapshot.font.cssFamily, fontRevision)
			const resolvedTheme = this.resolveTheme(lease, normalized.theme, defaultFontCssFamily)
			const physicalWidth = Math.ceil(normalized.width * normalized.devicePixelRatio)
			const physicalHeight = Math.ceil(normalized.height * normalized.devicePixelRatio)
			this.canvas.assertDimensions(physicalWidth, physicalHeight)
			const render: RenderEngineInput = Object.freeze({
				width: normalized.width,
				height: normalized.height,
				devicePixelRatio: normalized.devicePixelRatio,
				option: normalized.option,
				theme: resolvedTheme.value,
				injectOptionFont: resolvedTheme.injectOptionFont,
				defaultFontCssFamily,
				fontRevision,
				...(normalized.locale === undefined ? {} : { locale: normalized.locale }),
				...(normalized.setOption === undefined ? {} : { setOption: normalized.setOption }),
				output: normalized.output,
				maxDataUrlBytes: this.config.maxDataUrlBytes,
			})
			const result =
				normalized.execution === 'inline'
					? await renderECharts(
							render,
							this.canvas as unknown as RenderCanvasAdapter,
							abortLink.signal,
						)
					: await this.renderInWorker(render, abortLink.signal, canvasSnapshot)
			return toPublicResult(result)
		} catch (cause) {
			if (cause instanceof EChartsError) throw cause
			if (abortLink.signal.aborted) throw abortReason(abortLink.signal)
			throw new EChartsError('RENDER_FAILED', 'Apache ECharts server rendering failed', { cause })
		} finally {
			abortLink.dispose()
		}
	}

	private async renderInWorker(
		render: RenderEngineInput,
		signal: AbortSignal,
		canvas: CanvasWorkerSnapshot,
	): Promise<RenderEngineResult> {
		let response: EChartsWorkerOutput
		try {
			response = await this.ctx.workers.run(
				renderTask,
				{
					render,
					canvas,
				},
				{ signal },
			)
		} catch (cause) {
			if (signal.aborted) throw abortReason(signal)
			if (cause instanceof WorkerTaskError && cause.code === 'INVALID_INPUT') {
				throw new EChartsError(
					'WORKER_INPUT_UNSUPPORTED',
					'ECharts worker mode requires options compatible with structured clone; use execution: "inline" for formatter functions or native Canvas objects',
					{ cause },
				)
			}
			if (
				cause instanceof WorkerTaskError &&
				(cause.code === 'QUEUE_FULL' || cause.code === 'OWNER_QUEUE_FULL')
			) {
				throw new EChartsError('RENDER_BUSY', 'Shared worker task queue is full', { cause })
			}
			throw cause
		}
		if (response.ok === false) {
			throw new EChartsError(response.error.code, response.error.message)
		}
		return response.result
	}

	private resolveTheme(
		lease: EChartsLease,
		theme: string | EChartsTheme | undefined,
		defaultFontCssFamily: string,
	): Readonly<{ value: string | EChartsTheme; injectOptionFont: boolean }> {
		if (theme === undefined) {
			return Object.freeze({
				value: this.themeWithDefaultFont(EMPTY_THEME, defaultFontCssFamily),
				injectOptionFont: false,
			})
		}
		if (typeof theme === 'string') {
			const name = normalizeThemeName(theme)
			const registered = lease.themes.get(name)
			if (registered) {
				return Object.freeze({
					value: this.themeWithDefaultFont(registered.theme.value, defaultFontCssFamily),
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
			value: this.themeWithDefaultFont(normalized.value, defaultFontCssFamily),
			injectOptionFont: false,
		})
	}

	private themeWithDefaultFont(theme: EChartsTheme, cssFamily: string): EChartsTheme {
		const cached = this.themeFontCache.get(theme)
		if (cached?.cssFamily === cssFamily) return cached.value
		const value = themeWithDefaultFont(theme, cssFamily)
		this.themeFontCache.set(theme, Object.freeze({ cssFamily, value }))
		return value
	}

	private normalizeRenderInput(input: EChartsRenderInput): NormalizedRenderInput {
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
		if (
			input.execution !== undefined &&
			input.execution !== 'worker' &&
			input.execution !== 'inline'
		) {
			throw new EChartsError('INVALID_INPUT', 'execution must be worker or inline')
		}
		return Object.freeze({
			width: input.width,
			height: input.height,
			devicePixelRatio,
			option: input.option,
			...(input.theme === undefined ? {} : { theme: input.theme }),
			...(input.locale === undefined ? {} : { locale: input.locale.trim() }),
			...(input.setOption === undefined ? {} : { setOption: input.setOption }),
			output: normalizeOutput(input.output),
			execution: input.execution ?? 'worker',
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
		if (!Number.isFinite(value)) {
			throw new EChartsError('INVALID_THEME', 'Theme numbers must be finite')
		}
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

function rendererFontFamily(cssFamily: string, revision: number): string {
	return `${cssFamily}, "__pluxel_font_revision_${revision}"`
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

function toPublicResult(result: RenderEngineResult): EChartsRenderResult {
	return Object.freeze({
		...result,
		data: bufferView(result.data),
	})
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

export { EChartsConfig, EChartsError }
export type { EChartsErrorCode, EChartsOption, EChartsPluginConfig, SetOptionOpts }
