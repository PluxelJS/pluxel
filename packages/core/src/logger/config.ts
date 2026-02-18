import { basename, dirname, extname } from 'node:path'
import {
	type Config,
	compareLogLevel,
	type FilterLike,
	getTextFormatter,
	type LoggerConfig,
	type LogLevel,
	type LogRecord,
	parseLogLevel,
	type Sink,
} from '@logtape/logtape'
import type { Context } from '@pluxel/context'

import { pluxelCategories } from './categories'
import { mergeDefaults } from './merge'
import { readEnv } from './runtime'
import {
	createPluxelPrettyConsoleSink,
	getTimeRotatingFileSink,
	type PluxelPrettyConsoleSinkOptions,
	type TimeRotatingFileSinkOptions,
} from './sinks'
import {
	createPluxelPrettyTimestampFormatter,
	createPluxelTextTimestampFormatter,
	resolvePluxelLogFileTimezone,
	resolvePluxelLogTimezone,
} from './timestamp'
import { matchesTopic, normalizeTopic } from './topic'

export type PluxelLogtapeConfigPreset = 'core' | 'hmr'

export type PluxelUiLoggerOptions = {
	/** Sink id used in `config.sinks`. */
	id?: string
	/** The sink instance (e.g. `createLogStoreSink(...)`). */
	sink: Sink
	/** Categories that should write to this sink. */
	categories?: ReadonlyArray<string | readonly string[]>
	/** Lowest level for these categories. */
	lowestLevel?: LogLevel
	/** Whether to inherit parent sinks (default: LogTape default). */
	parentSinks?: 'inherit' | 'override'
}

export type PluxelUiOption = Sink | PluxelUiLoggerOptions

export type PluxelLogLevelInput = LogLevel | 'warn' | string
export type PluxelPluginLogLevel = PluxelLogLevelInput | null
export type PluxelPluginLogLevels =
	| Record<string, PluxelPluginLogLevel>
	| Map<string, PluxelPluginLogLevel>
	| ((pluginId: string) => PluxelPluginLogLevel | undefined)
	| PluxelPluginLevelState

export type PluxelPluginLevelState = {
	get(pluginId: string): PluxelPluginLogLevel | undefined
	set(pluginId: string, level: PluxelPluginLogLevel): void
	delete(pluginId: string): void
	clear(): void
	/** Whether there is any rule at all (default `'*'` or per-plugin). */
	hasAnyRules(): boolean
	/** Whether there is any per-plugin (non-`'*'`) rule. */
	hasPerPluginRules(): boolean
	/** Stored under `'*'`. */
	getDefault(): PluxelPluginLogLevel | undefined
	/** Stored under `'*'`. */
	setDefault(level: PluxelPluginLogLevel): void
	/** Snapshot for persistence/inspection. */
	toRecord(): Record<string, PluxelPluginLogLevel>
	/** Function form (dynamic): suitable for `createPluxelLogtapeConfig({ pluginLevels })`. */
	lookup: (pluginId: string) => PluxelPluginLogLevel | undefined
}

export function createPluxelPluginLevelState(
	init?: Record<string, PluxelPluginLogLevel>,
): PluxelPluginLevelState {
	const map = new Map<string, LogLevel | null>()
	let pluginRuleCount = 0 // excludes "*"
	let hasDefault = false
	if (init) {
		for (const [k, v] of Object.entries(init)) {
			const normalized = normalizeLogLevelInput(v)
			if (normalized === undefined) continue
			map.set(k, normalized)
			if (k === '*') hasDefault = true
			else pluginRuleCount++
		}
	}

	function set(pluginId: string, level: PluxelPluginLogLevel) {
		const normalized = normalizeLogLevelInput(level)
		const existed = map.has(pluginId)
		if (normalized === undefined) {
			if (!existed) return
			map.delete(pluginId)
			if (pluginId === '*') hasDefault = false
			else pluginRuleCount--
			return
		}

		map.set(pluginId, normalized)
		if (!existed) {
			if (pluginId === '*') hasDefault = true
			else pluginRuleCount++
		}
	}

	function del(pluginId: string) {
		const existed = map.has(pluginId)
		if (!existed) return
		map.delete(pluginId)
		if (pluginId === '*') hasDefault = false
		else pluginRuleCount--
	}

	function clear() {
		map.clear()
		pluginRuleCount = 0
		hasDefault = false
	}

	return {
		get(pluginId) {
			return map.get(pluginId)
		},
		set,
		delete: del,
		clear,
		hasAnyRules() {
			return hasDefault || pluginRuleCount > 0
		},
		hasPerPluginRules() {
			return pluginRuleCount > 0
		},
		getDefault() {
			return map.get('*')
		},
		setDefault(level) {
			set('*', level)
		},
		toRecord() {
			// Return a plain object (Object.prototype) so this snapshot is safe to serialize or send over RPC.
			const out: Record<string, PluxelPluginLogLevel> = {}
			for (const [k, v] of map.entries()) out[k] = v
			return out
		},
		lookup(pluginId) {
			return map.get(pluginId) ?? map.get('*')
		},
	}
}

export type PluxelLogtapeConfigOptions = {
	/**
	 * Preset for defaults (console formatter prefix, etc.).
	 * @default "core"
	 */
	preset?: PluxelLogtapeConfigPreset

	/** Lowest level for `["pluxel"]`. Defaults to `process.env.PLUXEL_LOG_LEVEL ?? "info"`. */
	lowestLevel?: LogLevel | null

	/**
	 * Console sink:
	 * - `undefined` / `true`: enabled with preset defaults
	 * - `false`: disabled
	 *
	 * Notes:
	 * - `createPluxelPrettyConsoleSink()` enables Youch by default for HMR/plugin errors
	 *   (see its JSDoc for details). Disable with `console: { youch: false }`.
	 */
	console?: PluxelPrettyConsoleSinkOptions | true | false

	/**
	 * Configure a rotating file sink (defaults to **daily time rotation**).
	 *
	 * Shorthands:
	 * - `string` / `{ path }`: treated as a *prefix path* (e.g. `/logs/app.log`)
	 *   and expanded to daily files in the same directory:
	 *   `/logs/app-YYYY-MM-DD.log`.
	 *
	 * Advanced:
	 * - `{ directory, filename?, interval?, maxAgeMs? }`: full time-rotating options
	 * - `{ sink }`: custom sink instance
	 */
	file?:
		| string
		| { path?: string; sink?: Sink }
		| (Pick<
				TimeRotatingFileSinkOptions,
				'directory' | 'filename' | 'interval' | 'maxAgeMs' | 'formatter'
		  > & { sink?: never })
		| false

	/**
	 * Optional "ui" sink (e.g. HMR log store) and category bindings.
	 * Default categories: `pluxelCategories.hmr` and `pluxelCategories.plugins`.
	 *
	 * Shorthand: pass the sink directly and defaults will be applied.
	 */
	ui?: PluxelUiOption | false

	/**
	 * Per-plugin log level overrides (matched by `record.properties.pluginId`).
	 *
	 * - `null` disables logging for that plugin.
	 * - `'*'` key is treated as a default for maps/records.
	 * - For dynamic routing, provide a function.
	 */
	pluginLevels?: PluxelPluginLogLevels
	/**
	 * Default log level for plugin logs when no plugin-level override matches.
	 * Falls back to `lowestLevel` when omitted.
	 */
	pluginLevelDefault?: PluxelPluginLogLevel

	/**
	 * Debug topics to enable at debug level.
	 *
	 * Input format:
	 * - `pluxel:hmr:batch` → enables that exact category
	 * - `pluxel:hmr:*` → enables the prefix category `["pluxel","hmr"]` (and thus its children)
	 * - `*` → enables all debug topics (discouraged)
	 *
	 * Implementation:
	 * - Debug logs use a single category channel: `["pluxel","debug"]`.
	 * - The concrete debug control is carried in `record.properties.debugTopic`.
	 * - This avoids duplicate logger config collisions when the host already binds
	 *   categories like `["pluxel","hmr"]` to custom sinks (LogTape forbids duplicates).
	 *
	 * These logger configs use the same sinks as `["pluxel"]` by default.
	 */
	debug?: readonly Context.DebugTopicPattern[]

	/** Extra sinks to merge into `config.sinks`. */
	extraSinks?: Record<string, Sink>
	/** Extra logger configs to append to `config.loggers`. */
	extraLoggers?: LoggerConfig<string, string>[]

	/** Include LogTape meta logger (defaults to true when console sink exists). */
	includeMeta?: boolean
	/** Lowest level for `["logtape","meta"]`. */
	metaLowestLevel?: LogLevel

	reset?: boolean
}

function resolveLowestLevel(explicit: LogLevel | null | undefined): LogLevel | null {
	if (explicit === null) return null
	if (explicit) return explicit
	const raw = readEnv('PLUXEL_LOG_LEVEL')
	if (!raw) return 'info'
	try {
		return parseLogLevel(raw)
	} catch {
		return 'info'
	}
}

function normalizeLogLevelInput(
	level: PluxelLogLevelInput | null | undefined,
): LogLevel | null | undefined {
	if (level === undefined) return undefined
	if (level === null) return null
	if (level === 'warn') return 'warning'
	// Fast path: avoid parse/allocs for the common case.
	if (
		level === 'trace' ||
		level === 'debug' ||
		level === 'info' ||
		level === 'warning' ||
		level === 'error' ||
		level === 'fatal'
	) {
		return level
	}
	return parseLogLevel(String(level))
}

type PluginLevelLookupFn = (pluginId: string | undefined) => LogLevel | null | undefined
type PluginLevelLookup = PluginLevelLookupFn & {
	/** If present, allows log filters to short-circuit without touching record.properties. */
	hasAnyRules?: () => boolean
	hasPerPluginRules?: () => boolean
	getDefault?: () => LogLevel | null | undefined
}

function normalizePluginLevels(input?: PluxelPluginLogLevels): PluginLevelLookup | null {
	if (!input) return null
	if (typeof input === 'object' && 'lookup' in input && typeof input.lookup === 'function') {
		const state = input as PluxelPluginLevelState
		const fn = ((pluginId: string | undefined) =>
			state.lookup(pluginId ?? '*') as LogLevel | null | undefined) as PluginLevelLookup
		fn.hasAnyRules = () => state.hasAnyRules()
		fn.hasPerPluginRules = () => state.hasPerPluginRules()
		fn.getDefault = () => state.getDefault() as LogLevel | null | undefined
		return fn
	}
	if (typeof input === 'function') {
		return (pluginId) => normalizeLogLevelInput(input(pluginId ?? '*'))
	}
	if (input instanceof Map) {
		const normalized = new Map<string, LogLevel | null>()
		for (const [key, value] of input.entries()) {
			const resolved = normalizeLogLevelInput(value)
			if (resolved !== undefined) normalized.set(key, resolved)
		}
		const fn = ((pluginId: string | undefined) =>
			normalized.get(pluginId ?? '*') ?? normalized.get('*')) as PluginLevelLookup
		const hasDefault = normalized.has('*')
		const perPluginRuleCount = normalized.size - (hasDefault ? 1 : 0)
		fn.hasAnyRules = () => normalized.size > 0
		fn.hasPerPluginRules = () => perPluginRuleCount > 0
		fn.getDefault = () => normalized.get('*')
		return fn
	}
	const normalized = new Map<string, LogLevel | null>()
	for (const [key, value] of Object.entries(input)) {
		const resolved = normalizeLogLevelInput(value)
		if (resolved !== undefined) normalized.set(key, resolved)
	}
	const fn = ((pluginId: string | undefined) =>
		normalized.get(pluginId ?? '*') ?? normalized.get('*')) as PluginLevelLookup
	const hasDefault = normalized.has('*')
	const perPluginRuleCount = normalized.size - (hasDefault ? 1 : 0)
	fn.hasAnyRules = () => normalized.size > 0
	fn.hasPerPluginRules = () => perPluginRuleCount > 0
	fn.getDefault = () => normalized.get('*')
	return fn
}

/**
 * Preset defaults for LogTape config generation.
 *
 * Notes:
 * - Youch defaults are owned by {@link createPluxelPrettyConsoleSink}; presets only set pretty defaults.
 */
const PLUXEL_LOGTAPE_PRESETS: Record<
	PluxelLogtapeConfigPreset,
	Omit<PluxelPrettyConsoleSinkOptions, 'pretty'> & {
		pretty: Omit<NonNullable<PluxelPrettyConsoleSinkOptions['pretty']>, 'timestamp'>
	}
> = {
	core: {
		pretty: {
			prefix: 'context',
			includeCaller: true,
		},
	},
	hmr: {
		pretty: {
			prefix: 'name',
			includeCaller: true,
		},
	},
} as const

function getPresetConsoleOptions(
	preset: PluxelLogtapeConfigPreset,
): PluxelPrettyConsoleSinkOptions {
	const base = PLUXEL_LOGTAPE_PRESETS[preset]
	return {
		...base,
		pretty: {
			...base.pretty,
			timestamp: createPluxelPrettyTimestampFormatter(resolvePluxelLogTimezone()),
		},
	}
}

function resolveConsoleOptions(
	preset: PluxelPrettyConsoleSinkOptions,
	input: PluxelLogtapeConfigOptions['console'],
): PluxelPrettyConsoleSinkOptions | false {
	if (input === false) return false
	if (input === true || input === undefined) return preset
	return mergeDefaults(input, preset) as PluxelPrettyConsoleSinkOptions
}

function normalizeUi(ui: PluxelUiOption): PluxelUiLoggerOptions {
	if (typeof ui === 'function') return { sink: ui }
	return ui
}

function formatDate(date: Date): string {
	const yyyy = date.getFullYear()
	const mm = String(date.getMonth() + 1).padStart(2, '0')
	const dd = String(date.getDate()).padStart(2, '0')
	return `${yyyy}-${mm}-${dd}`
}

function createDailyLogFilename(prefix: string, ext: string) {
	return (date: Date) => `${prefix}-${formatDate(date)}${ext}`
}

function renderTextFormatterValue(value: unknown): string {
	// LogTape's default "inspect" falls back to JSON.stringify in Node/Bun, which can throw for
	// values like BigInt or circular structures. This renderer is intentionally conservative:
	// it must never throw.
	if (typeof value === 'string') return JSON.stringify(value)
	if (typeof value === 'number' || typeof value === 'boolean') return String(value)
	if (typeof value === 'bigint') return JSON.stringify(`${value}n`)
	if (value === null) return 'null'
	if (value === undefined) return 'undefined'
	if (typeof value === 'symbol') return JSON.stringify(value.toString())
	if (typeof value === 'function') {
		const name = (value as { name?: unknown }).name
		return JSON.stringify(`[Function ${typeof name === 'string' && name ? name : 'anonymous'}]`)
	}

	const seen = new WeakSet<object>()
	try {
		const out = JSON.stringify(value, (_k, v) => {
			if (typeof v === 'bigint') return `${v}n`
			if (typeof v === 'symbol') return v.toString()
			if (typeof v === 'function') {
				const name = (v as { name?: unknown }).name
				return `[Function ${typeof name === 'string' && name ? name : 'anonymous'}]`
			}
			if (v && typeof v === 'object') {
				if (seen.has(v)) return '[Circular]'
				seen.add(v)
			}
			return v
		})
		return out ?? JSON.stringify(String(value))
	} catch {
		return JSON.stringify(String(value))
	}
}

function createPluxelSafeTextFormatter(timestamp: (ts: number) => string) {
	return getTextFormatter({
		timestamp,
		value: (v) => renderTextFormatterValue(v),
	})
}

function createDailyTimeRotatingFileSink(path: string, opts?: { maxAgeMs?: number }): Sink {
	const directory = dirname(path)
	const base = basename(path)
	const extRaw = extname(base)
	const ext = extRaw || '.log'
	const prefix = extRaw ? base.slice(0, -extRaw.length) : base

	return getTimeRotatingFileSink({
		directory,
		filename: prefix ? createDailyLogFilename(prefix, ext) : (d) => `${formatDate(d)}${ext}`,
		interval: 'daily',
		maxAgeMs: opts?.maxAgeMs,
		formatter: createPluxelSafeTextFormatter(
			createPluxelTextTimestampFormatter(resolvePluxelLogFileTimezone()),
		),
	})
}

type TimeRotatingFileOption = Pick<
	TimeRotatingFileSinkOptions,
	'directory' | 'filename' | 'interval' | 'maxAgeMs' | 'formatter'
>

function isTimeRotatingFileOption(value: unknown): value is TimeRotatingFileOption {
	if (!value || typeof value !== 'object') return false
	return typeof (value as Record<string, unknown>).directory === 'string'
}

type FilePathOrSinkOption = { path?: string; sink?: Sink }

function isFilePathOrSinkOption(value: unknown): value is FilePathOrSinkOption {
	if (!value || typeof value !== 'object') return false
	const v = value as Record<string, unknown>
	if ('sink' in v && v.sink !== undefined && typeof v.sink !== 'function') return false
	if ('path' in v && v.path !== undefined && typeof v.path !== 'string') return false
	return true
}

export function createPluxelLogtapeConfig(
	opts: PluxelLogtapeConfigOptions = {},
): Config<string, string> {
	const sinks: Record<string, Sink> = {}
	const loggers: LoggerConfig<string, string>[] = []
	const filters: Record<string, FilterLike> = {}

	const preset = opts.preset ?? 'core'

	const consoleOptions = resolveConsoleOptions(getPresetConsoleOptions(preset), opts.console)
	if (consoleOptions !== false) sinks.console = createPluxelPrettyConsoleSink(consoleOptions)

	const file = opts.file
	if (file !== false) {
		if (typeof file === 'string') sinks.file = createDailyTimeRotatingFileSink(file)
		else if (isTimeRotatingFileOption(file)) {
			sinks.file = getTimeRotatingFileSink({
				formatter:
					file.formatter ??
					createPluxelSafeTextFormatter(
						createPluxelTextTimestampFormatter(resolvePluxelLogFileTimezone()),
					),
				...file,
			})
		} else if (isFilePathOrSinkOption(file)) {
			if (file.sink) sinks.file = file.sink
			else if (file.path) sinks.file = createDailyTimeRotatingFileSink(file.path)
		}
	}

	const uiInput = opts.ui
	if (uiInput) {
		const ui = normalizeUi(uiInput)
		const id = ui.id ?? 'ui'
		sinks[id] = ui.sink
		const categories = ui.categories ?? [pluxelCategories.hmr, pluxelCategories.plugins]
		const lowestLevel = ui.lowestLevel ?? 'trace'
		for (const category of categories) {
			loggers.push({
				category:
					typeof category === 'string' ? category : Array.from(category as readonly string[]),
				sinks: [id],
				lowestLevel,
				parentSinks: ui.parentSinks,
			})
		}
	}

	if (opts.extraSinks) Object.assign(sinks, opts.extraSinks)

	const baseSinks: string[] = []
	if (sinks.console) baseSinks.push('console')
	if (sinks.file) baseSinks.push('file')

	const baseLowestLevel = resolveLowestLevel(opts.lowestLevel)
	const baseLogger: LoggerConfig<string, string> = {
		category: ['pluxel'],
		sinks: baseSinks.length ? baseSinks : undefined,
		lowestLevel: baseLowestLevel,
	}
	loggers.unshift(baseLogger)

	const pluginLevelLookup = normalizePluginLevels(opts.pluginLevels)
	const pluginDefaultLevel =
		opts.pluginLevelDefault !== undefined
			? normalizeLogLevelInput(opts.pluginLevelDefault)
			: baseLowestLevel
	if (pluginLevelLookup || opts.pluginLevelDefault !== undefined) {
		const id = 'pluxelPluginLevels'
		filters[id] = ((record: LogRecord) => {
			const category = record.category
			if (category[0] !== 'pluxel' || category[1] !== 'plugins') return true

			// Avoid touching record.properties unless we might need pluginId.
			// LogTape "properties" can be lazy (resolved via getters), so reading it can be expensive
			// and may allocate/compute more than we need.
			if (!pluginLevelLookup) {
				const level = pluginDefaultLevel
				if (level === null || level === undefined) return false
				return compareLogLevel(record.level, level) >= 0
			}
			if (pluginLevelLookup.hasAnyRules && pluginLevelLookup.hasAnyRules() === false) {
				const level = pluginDefaultLevel
				if (level === null || level === undefined) return false
				return compareLogLevel(record.level, level) >= 0
			}
			if (pluginLevelLookup.hasPerPluginRules && pluginLevelLookup.hasPerPluginRules() === false) {
				const overrideDefault = pluginLevelLookup.getDefault?.()
				const level = overrideDefault !== undefined ? overrideDefault : pluginDefaultLevel
				if (level === null || level === undefined) return false
				return compareLogLevel(record.level, level) >= 0
			}

			const props = record.properties
			const pluginId =
				props && typeof props === 'object' ? (props as Record<string, unknown>).pluginId : undefined
			const override = pluginLevelLookup(typeof pluginId === 'string' ? pluginId : undefined)
			const level = override !== undefined ? override : pluginDefaultLevel
			if (level === null || level === undefined) return false
			return compareLogLevel(record.level, level) >= 0
		}) satisfies FilterLike

		baseLogger.filters = baseLogger.filters ? [...baseLogger.filters, id] : [id]
	}

	// Always configure LogTape meta logger:
	// - avoids LogTape's default "auto configured" info message
	// - optionally routes internal logging errors to console/file when enabled
	{
		const includeMeta = opts.includeMeta ?? Boolean(sinks.console)
		const metaLowestLevel = opts.metaLowestLevel ?? 'error'
		const fallbackSinkId = 'logtapeMeta'

		const metaSinks: string[] = []
		if (includeMeta) {
			if (sinks.console) metaSinks.push('console')
			else if (sinks.file) metaSinks.push('file')
		}
		if (!metaSinks.length) {
			if (!(fallbackSinkId in sinks)) sinks[fallbackSinkId] = () => undefined
			metaSinks.push(fallbackSinkId)
		}

		loggers.push({
			category: ['logtape', 'meta'],
			sinks: metaSinks,
			lowestLevel: metaLowestLevel,
		})
	}

	// Always configure the debug channel category so it never "accidentally" inherits
	// the base `["pluxel"]` logger's level/sinks when hosts set PLUXEL_LOG_LEVEL=debug.
	// Debug is only enabled via `opts.debug` patterns.
	{
		const patterns: string[] = []
		for (const raw of opts.debug ?? []) {
			const s = normalizeTopic(raw)
			if (!s) continue
			patterns.push(s)
		}

		const id = 'pluxelDebugTopics'
		if (patterns.length) {
			filters[id] = ((record: LogRecord) => {
				const props = record.properties
				const topic =
					props && typeof props === 'object'
						? (props as Record<string, unknown>).debugTopic
						: undefined
				if (typeof topic !== 'string' || !topic) return patterns.includes('*')
				for (const p of patterns) {
					if (matchesTopic(p, topic)) return true
				}
				return false
			}) satisfies FilterLike
		}

		loggers.push({
			category: ['pluxel', 'debug'],
			// Use the same sinks as the base `["pluxel"]` logger by default.
			// Be explicit here to avoid relying on inheritance semantics across LogTape versions.
			sinks: baseSinks.length ? baseSinks : undefined,
			parentSinks: 'override',
			lowestLevel: patterns.length ? 'debug' : null,
			filters: patterns.length ? [id] : undefined,
		})
	}

	if (opts.extraLoggers?.length) loggers.push(...opts.extraLoggers)

	return {
		sinks,
		filters: Object.keys(filters).length ? filters : undefined,
		loggers,
		reset: opts.reset,
	}
}
