import {
	getFileSink,
	getRotatingFileSink,
	getStreamFileSink,
	getTimeRotatingFileSink,
	type TimeRotationInterval,
	type TimeRotatingFileSinkOptions,
} from '@logtape/file'
import {
	compareLogLevel,
	fromAsyncSink,
	getConsoleSink,
	type LogLevel,
	type LogRecord,
	type Sink,
} from '@logtape/logtape'
import { Youch } from 'youch'
import type { YouchANSIOptions } from 'youch/types'
import { pluxelCategories } from './categories'
import { findErrorInProps, findErrorInRecord, formatErrorStack, omitErrorProps } from './error'
import { createPluxelPrettyFormatter, type PluxelPrettyFormatterOptions } from './formatters'
import { mergeDefaults } from './merge'
import { createPluxelPrettyTimestampFormatter, resolvePluxelLogTimezone } from './timestamp'

/**
 * Single-entry "pretty" sink for local development:
 * - @logtape/pretty formatting
 * - optional Youch ANSI error rendering
 *
 * This is intentionally a sink (not just a formatter) because Youch rendering is async.
 */
export type PluxelPrettyConsoleSinkOptions = {
	/**
	 * Pretty formatter options.
	 *
	 * Defaults:
	 * - `timestamp: local time (HH:MM:SS)` (see `PLUXEL_LOG_TZ`)
	 * - `prefix: "name"`
	 * - `includeCaller: true`
	 */
	pretty?: PluxelPrettyFormatterOptions
	/**
	 * Youch ANSI error rendering (async).
	 *
	 * Defaults (enabled):
	 * - `minLevel: "error"`
	 * - `mode: "inline"` (avoid async interleaving / "错位 log")
	 * - `categoryPrefixes: [pluxelCategories.hmr, pluxelCategories.plugins]`
	 *
	 * Disable with `false`.
	 */
	youch?: PluxelYouchSinkOptions | false
}

const PLUXEL_PRETTY_DEFAULTS_BASE: Omit<PluxelPrettyFormatterOptions, 'timestamp'> = {
	prefix: 'name',
	includeCaller: true,
}

const PLUXEL_YOUCH_DEFAULTS: PluxelYouchSinkOptions = {
	minLevel: 'error',
	mode: 'inline',
	categoryPrefixes: [pluxelCategories.hmr, pluxelCategories.plugins],
}

export function createPluxelPrettyConsoleSink(opts: PluxelPrettyConsoleSinkOptions = {}): Sink {
	const prettyDefaults: PluxelPrettyFormatterOptions = {
		...PLUXEL_PRETTY_DEFAULTS_BASE,
		timestamp: createPluxelPrettyTimestampFormatter(resolvePluxelLogTimezone()),
	}
	const pretty = mergeDefaults<PluxelPrettyFormatterOptions>(opts.pretty, prettyDefaults)
	const formatter = createPluxelPrettyFormatter(pretty)
	const baseConsoleSink = getConsoleSink({ formatter })
	if (opts.youch === false) return baseConsoleSink

	const youchOptions =
		opts.youch === undefined
			? PLUXEL_YOUCH_DEFAULTS
			: mergeDefaults<PluxelYouchSinkOptions>(opts.youch, PLUXEL_YOUCH_DEFAULTS)
	const youchMode = youchOptions.mode ?? PLUXEL_YOUCH_DEFAULTS.mode
	const matcher = createYouchMatcher(youchOptions)

	const consoleSink: Sink = (record) => {
		// Avoid double-rendering stacks when Youch is enabled for this record.
		if (matcher(record) && findErrorInProps(record) instanceof Error) {
			baseConsoleSink(omitErrorProps(record))
			return
		}
		baseConsoleSink(record)
	}

	if (youchMode === 'inline') {
		const inline = createPluxelInlineYouchConsoleSink(formatter, youchOptions)
		return (record) => {
			if (inline.shouldHandle(record)) {
				inline.enqueue(record)
				return
			}
			consoleSink(record)
		}
	}

	return composeSinks(consoleSink, createPluxelYouchSink(youchOptions))
}

export type PluxelYouchSinkOptions = {
	/** @default "error" */
	minLevel?: LogLevel
	ansi?: YouchANSIOptions
	/**
	 * Rendering strategy:
	 * - "sidecar": print the normal log line immediately, then render Youch async to stderr (may interleave).
	 * - "inline": delay the whole log until Youch is ready, then print the log line + Youch output together.
	 *
	 * Note: {@link createPluxelPrettyConsoleSink} defaults this to `"inline"` to avoid interleaving.
	 * @default "inline"
	 */
	mode?: 'sidecar' | 'inline'
	/** Only render when record.category matches any of these prefixes. */
	categoryPrefixes?: ReadonlyArray<readonly string[]>
	/** Custom predicate to decide whether a record should be considered for Youch. */
	filter?: (record: LogRecord) => boolean
}

function writeToStderr(text: string) {
	const out = text.endsWith('\n') ? text : `${text}\n`

	const p = (globalThis as unknown as { process?: { stderr?: { write?: (s: string) => void } } })
		.process
	if (p?.stderr?.write) p.stderr.write(out)
	else console.error(out)
}

function isCategoryPrefixed(category: readonly string[], prefix: readonly string[]): boolean {
	if (prefix.length > category.length) return false
	for (let i = 0; i < prefix.length; i++) {
		if (category[i] !== prefix[i]) return false
	}
	return true
}

function createYouchMatcher(opts: PluxelYouchSinkOptions): (record: LogRecord) => boolean {
	const prefixes = opts.categoryPrefixes?.length ? opts.categoryPrefixes : null
	const filter = typeof opts.filter === 'function' ? opts.filter : null
	const minLevel = opts.minLevel ?? 'error'

	return (record) => {
		if (compareLogLevel(record.level, minLevel) < 0) return false

		if (prefixes) {
			let ok = false
			for (const p of prefixes) {
				if (isCategoryPrefixed(record.category, p)) {
					ok = true
					break
				}
			}
			if (!ok) return false
		}
		if (filter && !filter(record)) return false
		return true
	}
}

export function createPluxelYouchSink(opts: PluxelYouchSinkOptions = {}): Sink {
	const matches = createYouchMatcher(opts)
	let youch: Youch | undefined
	const getYouch = () => (youch ??= new Youch())

	return fromAsyncSink(async (record) => {
		if (!matches(record)) return
		const error = findErrorInRecord(record)
		if (!(error instanceof Error)) return
		const rendered = await getYouch().toANSI(error, opts.ansi)
		writeToStderr(rendered)
	})
}

function stripTrailingNewlines(text: string): string {
	return text.replace(/\n+$/g, '')
}

function createPluxelInlineYouchConsoleSink(
	formatter: (record: LogRecord) => string,
	opts: PluxelYouchSinkOptions,
) {
	const matches = createYouchMatcher(opts)
	let youch: Youch | undefined
	const getYouch = () => (youch ??= new Youch())

	const shouldHandle = (record: LogRecord) => {
		if (!matches(record)) return false
		const error = findErrorInRecord(record)
		return error instanceof Error
	}

	const enqueue = fromAsyncSink(async (record) => {
		const error = findErrorInRecord(record)
		if (!(error instanceof Error)) return

		let rendered = ''
		try {
			rendered = await getYouch().toANSI(error, opts.ansi)
		} catch {
			rendered = formatErrorStack(error)
		}

		const header = stripTrailingNewlines(formatter(omitErrorProps(record)))
		writeToStderr(`${header}\n${rendered}`)
	})

	return { shouldHandle, enqueue }
}

export function composeSinks(...sinks: Sink[]): Sink {
	return (record) => {
		for (const sink of sinks) {
			try {
				sink(record)
			} catch {
				// Swallow to avoid blocking other sinks.
			}
		}
	}
}

// Re-export official file sinks (apps configure these explicitly).
export {
	getFileSink,
	getRotatingFileSink,
	getStreamFileSink,
	getTimeRotatingFileSink,
	type TimeRotationInterval,
	type TimeRotatingFileSinkOptions,
}
