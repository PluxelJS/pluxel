import { CanvasPlugin } from '@pluxel/canvas'
import { FontsPlugin, type DefaultFontSnapshot } from '@pluxel/fonts'
import {
	BasePlugin,
	defineWorkerTask,
	Plugin,
	type Context,
	WorkerTaskError,
} from '@pluxel/runtime'
import type { EChartsOption, SetOptionOpts } from 'echarts'
import { EChartsConfig, type EChartsPluginConfig } from './config.ts'
import { EChartsError, type EChartsErrorCode } from './errors.ts'
import {
	assertEChartsVersion,
	type RenderEngineInput,
	type RenderEngineResult,
} from './render-engine.ts'
import { assertRenderDataBudget } from './render-input.ts'
import type { EChartsWorkerInput, EChartsWorkerOutput } from './worker.ts'
import { EChartsWorkbench } from './workbench.ts'

const MAX_THEME_NAME_LENGTH = 128
const BUILTIN_THEMES = new Set(['default', 'dark'])
const EMPTY_THEME: EChartsTheme = Object.freeze({})

const renderTask = defineWorkerTask<EChartsWorkerInput, EChartsWorkerOutput>(
	import.meta.url,
	'./worker.ts',
)

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
	/** Borrowed without mutation until render settles; must contain only declarative cloneable data. */
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
	/** Cancels worker admission or execution. */
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

type EChartsGeneration = Readonly<{
	themeBudget: {
		count: number
		bytes: number
	}
}>

type EChartsLease = {
	readonly owner: Context
	readonly generation: EChartsGeneration
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
	private generation?: EChartsGeneration

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
		const generation: EChartsGeneration = Object.freeze({
			themeBudget: { count: 0, bytes: 0 },
		})
		this.generation = generation
		this.ctx.effects.defer(
			() => {
				if (this.generation === generation) this.generation = undefined
				for (const lease of this.leases) {
					if (lease.generation === generation) this.closeLease(lease)
				}
			},
			{ tag: 'echarts-generation' },
		)
		this.ctx.workbench?.publish(EChartsWorkbench, {
			fonts: { provider: this.fonts },
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
		if (lease.generation.themeBudget.count >= this.config.maxTotalThemes) {
			throw new EChartsError(
				'THEME_LIMIT_EXCEEDED',
				`EChartsPlugin reached its ${this.config.maxTotalThemes} retained theme limit`,
			)
		}
		const theme = normalizeTheme(input.theme, {
			maxBytes: this.config.maxThemeBytes,
			maxNodes: this.config.maxThemeNodes,
			maxDepth: this.config.maxThemeDepth,
		})
		const budget = lease.generation.themeBudget
		if (theme.byteLength > this.config.maxTotalThemeBytes - budget.bytes) {
			throw new EChartsError(
				'THEME_LIMIT_EXCEEDED',
				`Retained themes would exceed the configured ${this.config.maxTotalThemeBytes} byte limit`,
			)
		}
		let owned!: OwnedTheme
		const handle = new ThemeRegistrationHandle(name, () => {
			if (lease.themes.get(name) !== owned) return
			lease.themes.delete(name)
			budget.count -= 1
			budget.bytes -= owned.theme.byteLength
			handle.deactivate()
		})
		owned = Object.freeze({ theme, handle })
		lease.themes.set(name, owned)
		budget.count += 1
		budget.bytes += theme.byteLength
		return handle
	}

	/** Render declarative options through the shared worker pool. */
	async render(input: EChartsRenderInput): Promise<EChartsRenderResult> {
		const lease = this.requireLease()
		if (!input || typeof input !== 'object' || Array.isArray(input)) {
			throw new EChartsError('INVALID_INPUT', 'render() requires an input object')
		}
		if (input?.signal !== undefined && !isAbortSignal(input.signal)) {
			throw new EChartsError('INVALID_INPUT', 'signal must be an AbortSignal')
		}
		const normalized = this.normalizeRenderInput(input)
		const physicalWidth = Math.ceil(normalized.width * normalized.devicePixelRatio)
		const physicalHeight = Math.ceil(normalized.height * normalized.devicePixelRatio)
		this.canvas.assertDimensions(physicalWidth, physicalHeight)
		const abortLink = linkAbortSignals([lease.controller.signal, input.signal])
		try {
			if (abortLink.signal.aborted) throw abortReason(abortLink.signal)
			const result = await this.renderInWorker(
				(signal) => this.prepareWorkerInput(lease, normalized, signal),
				abortLink.signal,
			)
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
		prepare: (signal: AbortSignal) => Promise<EChartsWorkerInput>,
		signal: AbortSignal,
	): Promise<RenderEngineResult> {
		let response: EChartsWorkerOutput
		try {
			response = await this.ctx.workers.runPrepared(renderTask, prepare, {
				signal,
				inputOwnership: 'borrowed',
			})
		} catch (cause) {
			if (signal.aborted) throw abortReason(signal)
			if (cause instanceof WorkerTaskError && cause.code === 'INVALID_INPUT') {
				throw new EChartsError(
					'WORKER_INPUT_UNSUPPORTED',
					'ECharts options must contain only declarative structured-clone-compatible data',
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

	private async prepareWorkerInput(
		lease: EChartsLease,
		input: NormalizedRenderInput,
		signal: AbortSignal,
	): Promise<EChartsWorkerInput> {
		await assertRenderDataBudget(
			[input.option, ...(input.setOption === undefined ? [] : [input.setOption])],
			{
				maxBytes: this.config.maxOptionBytes,
				maxNodes: this.config.maxOptionNodes,
				maxDepth: this.config.maxOptionDepth,
			},
			signal,
		)
		const canvas = this.canvas.workerSnapshot
		const fontRevision = canvas.font.revision
		const defaultFontCssFamily = rendererFontFamily(canvas.font.cssFamily, fontRevision)
		const resolvedTheme = this.resolveTheme(lease, input.theme, defaultFontCssFamily)
		const render: RenderEngineInput = Object.freeze({
			width: input.width,
			height: input.height,
			devicePixelRatio: input.devicePixelRatio,
			option: input.option,
			theme: resolvedTheme.value,
			injectOptionFont: resolvedTheme.injectOptionFont,
			defaultFontCssFamily,
			...(input.locale === undefined ? {} : { locale: input.locale }),
			...(input.setOption === undefined ? {} : { setOption: input.setOption }),
			output: input.output,
			maxDataUrlBytes: this.config.maxDataUrlBytes,
			maxImages: this.config.maxImages,
			maxTotalImageBytes: this.config.maxTotalImageBytes,
			maxTotalImagePixels: this.config.maxTotalImagePixels,
			maxOutputBytes: this.config.maxOutputBytes,
		})
		return Object.freeze({ render, canvas })
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
		const normalized = normalizeTheme(theme, {
			maxBytes: this.config.maxThemeBytes,
			maxNodes: this.config.maxThemeNodes,
			maxDepth: this.config.maxThemeDepth,
		})
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
		return Object.freeze({
			width: input.width,
			height: input.height,
			devicePixelRatio,
			option: input.option,
			...(input.theme === undefined ? {} : { theme: input.theme }),
			...(input.locale === undefined ? {} : { locale: input.locale.trim() }),
			...(input.setOption === undefined ? {} : { setOption: input.setOption }),
			output: normalizeOutput(input.output),
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
		for (const { handle } of lease.themes.values()) handle.dispose()
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

function normalizeTheme(
	value: unknown,
	limits: Readonly<{ maxBytes: number; maxNodes: number; maxDepth: number }>,
): NormalizedTheme {
	if (!isPlainRecord(value)) {
		throw new EChartsError('INVALID_THEME', 'Theme must be a plain JSON object')
	}
	const seen = new WeakSet<object>()
	const budget = { bytes: 0, nodes: 0 }
	const normalized = cloneThemeValue(value, seen, 0, limits, budget) as EChartsTheme
	return Object.freeze({ value: deepFreeze(normalized), byteLength: budget.bytes })
}

function cloneThemeValue(
	value: unknown,
	seen: WeakSet<object>,
	depth: number,
	limits: Readonly<{ maxBytes: number; maxNodes: number; maxDepth: number }>,
	budget: { bytes: number; nodes: number },
): EChartsThemeValue {
	budget.nodes += 1
	if (budget.nodes > limits.maxNodes) {
		throw new EChartsError(
			'THEME_TOO_LARGE',
			`Theme exceeds the configured ${limits.maxNodes} value limit`,
		)
	}
	if (depth > limits.maxDepth) {
		throw new EChartsError('INVALID_THEME', `Theme nesting exceeds ${limits.maxDepth} levels`)
	}
	if (value === null) {
		addThemeBytes(budget, 4, limits.maxBytes)
		return null
	}
	if (typeof value === 'string') {
		addThemeBytes(budget, Buffer.byteLength(JSON.stringify(value), 'utf8'), limits.maxBytes)
		return value
	}
	if (typeof value === 'boolean') {
		addThemeBytes(budget, value ? 4 : 5, limits.maxBytes)
		return value
	}
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) {
			throw new EChartsError('INVALID_THEME', 'Theme numbers must be finite')
		}
		addThemeBytes(budget, Buffer.byteLength(String(value), 'utf8'), limits.maxBytes)
		return value
	}
	if (!value || typeof value !== 'object') {
		throw new EChartsError('INVALID_THEME', 'Theme values must be JSON-compatible')
	}
	if (seen.has(value)) throw new EChartsError('INVALID_THEME', 'Theme must not contain cycles')
	seen.add(value)
	try {
		if (Array.isArray(value)) {
			addThemeBytes(budget, value.length === 0 ? 2 : value.length + 1, limits.maxBytes)
			if (budget.nodes + value.length > limits.maxNodes) {
				throw new EChartsError(
					'THEME_TOO_LARGE',
					`Theme exceeds the configured ${limits.maxNodes} value limit`,
				)
			}
			const result: EChartsThemeValue[] = []
			for (let index = 0; index < value.length; index += 1) {
				const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
				if (!descriptor || !('value' in descriptor)) {
					throw new EChartsError(
						'INVALID_THEME',
						'Theme arrays must be dense and must not contain accessors',
					)
				}
				result.push(cloneThemeValue(descriptor.value, seen, depth + 1, limits, budget))
			}
			return result
		}
		if (!isPlainRecord(value)) {
			throw new EChartsError('INVALID_THEME', 'Theme values must use plain objects and arrays')
		}
		const result: Record<string, EChartsThemeValue> = {}
		const keys = Object.keys(value)
		addThemeBytes(budget, keys.length === 0 ? 2 : keys.length + 1, limits.maxBytes)
		for (const symbol of Object.getOwnPropertySymbols(value)) {
			if (Object.getOwnPropertyDescriptor(value, symbol)?.enumerable) {
				throw new EChartsError(
					'INVALID_THEME',
					'Theme must not contain enumerable symbol properties',
				)
			}
		}
		for (const key of keys) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key)!
			if (!('value' in descriptor)) {
				throw new EChartsError('INVALID_THEME', 'Theme must not contain accessor properties')
			}
			addThemeBytes(budget, Buffer.byteLength(JSON.stringify(key), 'utf8') + 1, limits.maxBytes)
			Object.defineProperty(result, key, {
				configurable: true,
				enumerable: true,
				value: cloneThemeValue(descriptor.value, seen, depth + 1, limits, budget),
				writable: true,
			})
		}
		return result
	} finally {
		seen.delete(value)
	}
}

function addThemeBytes(budget: { bytes: number }, bytes: number, maxBytes: number): void {
	budget.bytes += bytes
	if (!Number.isSafeInteger(budget.bytes) || budget.bytes > maxBytes) {
		throw new EChartsError('THEME_TOO_LARGE', `Theme exceeds the configured ${maxBytes} byte limit`)
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

function isAbortSignal(value: unknown): value is AbortSignal {
	return Boolean(
		value &&
		typeof value === 'object' &&
		typeof (value as AbortSignal).aborted === 'boolean' &&
		typeof (value as AbortSignal).addEventListener === 'function' &&
		typeof (value as AbortSignal).removeEventListener === 'function',
	)
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
