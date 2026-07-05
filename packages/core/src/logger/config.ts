import {
	type Config,
	compareLogLevel,
	type FilterLike,
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
import { createPluxelPrettyConsoleSink, type PluxelPrettyConsoleSinkOptions } from './sinks'
import { createPluxelPrettyTimestampFormatter, resolvePluxelLogTimezone } from './timestamp'
import { matchesTopic, normalizeTopic } from './topic'

export type PluxelLogtapeConfigPreset = 'core' | 'hmr'

export type PluxelUiLoggerOptions = {
	/** Sink id used in `config.sinks`. */
	id?: string
	/** The sink instance (e.g. `createRuntimeLogSink(...)`). */
	sink: Sink
	/** Categories that should write to this sink. */
	categories?: ReadonlyArray<string | readonly string[]>
	/** Lowest level for these categories. */
	lowestLevel?: LogLevel
	/** Whether to inherit parent sinks (default: LogTape default). */
	parentSinks?: 'inherit' | 'override'
}

export type PluxelUiOption = Sink | PluxelUiLoggerOptions

export type PluxelPluginLevelLookup = (pluginId: string | undefined) => LogLevel | null | undefined

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
	 * Optional file sink (Node-only).
	 *
	 * Note:
	 * - `@pluxel/core` does not build file sinks from a path. If you need the
	 *   "daily rotation by prefix path" behavior, use `@pluxel/runtime/logger`
	 *   (e.g. `ensurePluxelLogging({ file: "./logs/app.log" })`) or pass a custom sink
	 *   created by `@logtape/file`.
	 */
	file?: Sink | false

	/**
	 * Optional "ui" sink (e.g. HMR log store) and category bindings.
	 * Default categories: `pluxelCategories.hmr` and `pluxelCategories.plugins`.
	 *
	 * Shorthand: pass the sink directly and defaults will be applied.
	 */
	ui?: PluxelUiOption | false

	/** Runtime plugin log policy lookup. `null` disables the plugin. */
	pluginLevelLookup?: PluxelPluginLevelLookup

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
	if (file) sinks.file = file

	const uiInput = opts.ui
	if (uiInput) {
		const ui = normalizeUi(uiInput)
		const id = ui.id ?? 'ui'
		sinks[id] = ui.sink
		const categories = ui.categories ?? [pluxelCategories.hmr, pluxelCategories.plugins]
		const lowestLevel = ui.lowestLevel ?? 'trace'
		for (const category of categories) {
			loggers.push({
				category: typeof category === 'string' ? category : [...(category as readonly string[])],
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
		sinks: baseSinks.length > 0 ? baseSinks : undefined,
		lowestLevel: baseLowestLevel,
	}
	loggers.unshift(baseLogger)

	if (opts.pluginLevelLookup) {
		const id = 'pluxelPluginLevels'
		filters[id] = ((record: LogRecord) => {
			const category = record.category
			if (category[0] !== 'pluxel' || category[1] !== 'plugins') return true

			const props = record.properties
			const pluginId =
				props && typeof props === 'object' ? (props as Record<string, unknown>).pluginId : undefined
			const level = opts.pluginLevelLookup!(typeof pluginId === 'string' ? pluginId : undefined)
			if (level === undefined) return true
			if (level === null) return false
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
		if (metaSinks.length === 0) {
			if (!(fallbackSinkId in sinks)) sinks[fallbackSinkId] = () => {}
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
		if (patterns.length > 0) {
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
			sinks: baseSinks.length > 0 ? baseSinks : undefined,
			parentSinks: 'override',
			lowestLevel: patterns.length > 0 ? 'debug' : null,
			filters: patterns.length > 0 ? [id] : undefined,
		})
	}

	if (opts.extraLoggers?.length) loggers.push(...opts.extraLoggers)

	return {
		sinks,
		filters: Object.keys(filters).length > 0 ? filters : undefined,
		loggers,
		reset: opts.reset,
	}
}
