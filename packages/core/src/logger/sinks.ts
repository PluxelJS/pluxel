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
	const consoleSink = getConsoleSink({ formatter: createPluxelPrettyFormatter(opts.pretty) })
	if (opts.youch === false) return consoleSink
	return composeSinks(consoleSink, createPluxelYouchSink(opts.youch))
}

export type PluxelYouchSinkOptions = {
	minLevel?: LogLevel
	ansi?: YouchANSIOptions
}

function findErrorInRecord(record: LogRecord): unknown {
	if (record.properties.error) return record.properties.error
	for (let i = 1; i < record.message.length; i += 2) {
		const v = record.message[i]
		if (v instanceof Error) return v
	}
	return undefined
}

export function createPluxelYouchSink(opts: PluxelYouchSinkOptions = {}): Sink {
	const minLevel = opts.minLevel ?? 'error'
	const youch = new Youch()

	const write = (text: string) => {
		const out = text.endsWith('\n') ? text : `${text}\n`
		const p = (globalThis as any).process as undefined | { stderr?: { write?: (s: string) => void } }
		if (p?.stderr?.write) p.stderr.write(out)
		else console.error(out)
	}

	return fromAsyncSink(async (record) => {
		if (compareLogLevel(record.level, minLevel) < 0) return
		const error = findErrorInRecord(record)
		if (!(error instanceof Error)) return
		const rendered = await youch.toANSI(error, opts.ansi)
		write(rendered)
	})
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
	return composeSinks(consoleSink, createPluxelYouchSink(opts.youch))
}

// Re-export official file sinks (apps configure these explicitly).
export { getFileSink, getRotatingFileSink, getStreamFileSink }
