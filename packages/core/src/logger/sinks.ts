import {
	compareLogLevel,
	fromAsyncSink,
	getConsoleSink,
	type LogLevel,
	type LogRecord,
	type Sink,
} from '@logtape/logtape'
import { getFileSink, getRotatingFileSink, getStreamFileSink } from '@logtape/file'
import { Youch } from 'youch'

import {
	createPluxelConsoleFormatter,
	createPluxelPrettyFormatter,
	type PluxelPrettyFormatterOptions,
	type PluxelPrettyOptions,
} from './formatters'
import type { YouchANSIOptions } from 'youch/types'

export type PluxelConsoleSinkOptions = {
	/** Use the legacy console formatter instead of @logtape/pretty. */
	legacyFormatter?: boolean
	legacy?: PluxelPrettyOptions
	pretty?: PluxelPrettyFormatterOptions
}

export function createPluxelConsoleSink(opts: PluxelConsoleSinkOptions = {}): Sink {
	if (opts.legacyFormatter) {
		return getConsoleSink({ formatter: createPluxelConsoleFormatter(opts.legacy) })
	}
	return getConsoleSink({ formatter: createPluxelPrettyFormatter(opts.pretty) })
}

/**
 * Single-entry "pretty" sink for local development:
 * - @logtape/pretty formatting
 * - optional Youch ANSI error rendering
 *
 * This is intentionally a sink (not just a formatter) because Youch rendering is async.
 */
export type PluxelPrettyConsoleSinkOptions = {
	pretty?: PluxelPrettyFormatterOptions
	youch?: PluxelYouchSinkOptions | false
}

export function createPluxelPrettyConsoleSink(opts: PluxelPrettyConsoleSinkOptions = {}): Sink {
	const formatter = createPluxelPrettyFormatter(opts.pretty)
	const baseConsoleSink = getConsoleSink({ formatter })
	if (opts.youch === false) return baseConsoleSink

	const youchOptions = opts.youch ?? {}
	const youchMode = youchOptions.mode ?? 'sidecar'
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
	minLevel?: LogLevel
	ansi?: YouchANSIOptions
	/**
	 * Rendering strategy:
	 * - "sidecar": print the normal log line immediately, then render Youch async to stderr (may interleave).
	 * - "inline": delay the whole log until Youch is ready, then print the log line + Youch output together.
	 */
	mode?: 'sidecar' | 'inline'
	/** Only render when record.category matches any of these prefixes. */
	categoryPrefixes?: ReadonlyArray<readonly string[]>
	/** Custom predicate to decide whether a record should be considered for Youch. */
	filter?: (record: LogRecord) => boolean
}

function findErrorInRecord(record: LogRecord): unknown {
	if (record.properties.error) return record.properties.error
	if (record.properties.err) return record.properties.err
	for (let i = 1; i < record.message.length; i += 2) {
		const v = record.message[i]
		if (v instanceof Error) return v
	}
	return undefined
}

function findErrorInProps(record: LogRecord): unknown {
	if ((record.properties as any)?.error) return (record.properties as any).error
	if ((record.properties as any)?.err) return (record.properties as any).err
	return undefined
}

function writeToStderr(text: string) {
	const out = text.endsWith('\n') ? text : `${text}\n`
	const p = (globalThis as any).process as undefined | { stderr?: { write?: (s: string) => void } }
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
	const youch = new Youch()
	const matches = createYouchMatcher(opts)

	return fromAsyncSink(async (record) => {
		if (!matches(record)) return
		const error = findErrorInRecord(record)
		if (!(error instanceof Error)) return
		const rendered = await youch.toANSI(error, opts.ansi)
		writeToStderr(rendered)
	})
}

function stripTrailingNewlines(text: string): string {
	return text.replace(/\n+$/g, '')
}

function omitErrorProps(record: LogRecord): LogRecord {
	const props = record.properties as Record<string, unknown>
	if (!props || typeof props !== 'object') return record
	if (!('error' in props) && !('err' in props)) return record
	const { error: _error, err: _err, ...rest } = props
	return { ...record, properties: rest } as LogRecord
}

function createPluxelInlineYouchConsoleSink(
	formatter: (record: LogRecord) => string,
	opts: PluxelYouchSinkOptions,
) {
	const matches = createYouchMatcher(opts)
	const youch = new Youch()

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
			rendered = await youch.toANSI(error, opts.ansi)
		} catch {
			rendered = typeof error.stack === 'string' && error.stack.length > 0 ? error.stack : String(error)
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

export type PluxelDevConsoleSinkOptions = PluxelConsoleSinkOptions & {
	youch?: PluxelYouchSinkOptions | false
}

export function createPluxelDevConsoleSink(opts: PluxelDevConsoleSinkOptions = {}): Sink {
	const consoleSink = createPluxelConsoleSink(opts)
	if (opts.youch === false) return consoleSink

	const youchOptions = opts.youch ?? {}
	const youchMode = youchOptions.mode ?? 'sidecar'
	const matcher = createYouchMatcher(youchOptions)

	const wrappedConsole: Sink = (record) => {
		if (matcher(record) && findErrorInProps(record) instanceof Error) {
			consoleSink(omitErrorProps(record))
			return
		}
		consoleSink(record)
	}

	if (youchMode === 'inline' && !opts.legacyFormatter) {
		const formatter = createPluxelPrettyFormatter(opts.pretty)
		const inline = createPluxelInlineYouchConsoleSink(formatter, youchOptions)
		return (record) => {
			if (inline.shouldHandle(record)) {
				inline.enqueue(record)
				return
			}
			wrappedConsole(record)
		}
	}

	return composeSinks(wrappedConsole, createPluxelYouchSink(youchOptions))
}

// Re-export official file sinks (apps configure these explicitly).
export { getFileSink, getRotatingFileSink, getStreamFileSink }
