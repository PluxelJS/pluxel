import {
	type Config,
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
import {
	createPluxelPrettyConsoleSink,
	getRotatingFileSink,
	type PluxelPrettyConsoleSinkOptions,
} from './sinks'
import { matchesTopic, normalizeTopic } from './topic'

export type PluxelLogtapeConfigPreset = 'core' | 'hmr'

export type PluxelUiLoggerOptions = {
	/** Sink id used in `config.sinks`. */
	id?: string
	/** The sink instance (e.g. `createLogStoreSink(...)`). */
	sink: Sink
	/** Categories that should write to this sink. */
	categories?: ReadonlyArray<string | string[]>
	/** Lowest level for these categories. */
	lowestLevel?: LogLevel
	/** Whether to inherit parent sinks (default: LogTape default). */
	parentSinks?: 'inherit' | 'override'
}

export type PluxelUiOption = Sink | PluxelUiLoggerOptions

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
	 * Configure a rotating file sink:
	 * - `string`: the file path
	 * - `{ path }`: the file path
	 * - `{ sink }`: custom sink instance
	 */
	file?: string | { path?: string; sink?: Sink } | false

	/**
	 * Optional "ui" sink (e.g. HMR log store) and category bindings.
	 * Default categories: `pluxelCategories.hmr` and `pluxelCategories.plugins`.
	 *
	 * Shorthand: pass the sink directly and defaults will be applied.
	 */
	ui?: PluxelUiOption | false

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
const PLUXEL_LOGTAPE_PRESETS: Record<PluxelLogtapeConfigPreset, PluxelPrettyConsoleSinkOptions> = {
	core: {
		pretty: {
			timestamp: 'time',
			prefix: 'context',
			includeCaller: true,
		},
	},
	hmr: {
		pretty: {
			timestamp: 'time',
			prefix: 'name',
			includeCaller: true,
		},
	},
} as const

function getPresetConsoleOptions(
	preset: PluxelLogtapeConfigPreset,
): PluxelPrettyConsoleSinkOptions {
	return PLUXEL_LOGTAPE_PRESETS[preset]
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
	if (file !== false) {
		if (typeof file === 'string') sinks.file = getRotatingFileSink(file)
		else if (file?.sink) sinks.file = file.sink
		else if (file?.path) sinks.file = getRotatingFileSink(file.path)
	}

	const uiInput = opts.ui
	if (uiInput && uiInput !== false) {
		const ui = normalizeUi(uiInput)
		const id = ui.id ?? 'ui'
		sinks[id] = ui.sink
		const categories = ui.categories ?? [pluxelCategories.hmr, pluxelCategories.plugins]
		const lowestLevel = ui.lowestLevel ?? 'trace'
		for (const category of categories) {
			loggers.push({
				category,
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

	loggers.unshift({
		category: ['pluxel'],
		sinks: baseSinks.length ? baseSinks : undefined,
		lowestLevel: resolveLowestLevel(opts.lowestLevel),
	})

	const includeMeta = opts.includeMeta ?? Boolean(sinks.console)
	if (includeMeta && sinks.console) {
		loggers.push({
			category: ['logtape', 'meta'],
			sinks: ['console'],
			lowestLevel: opts.metaLowestLevel ?? 'error',
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
