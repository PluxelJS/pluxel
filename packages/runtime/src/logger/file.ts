import {
	getTimeRotatingFileSink,
	type TimeRotationInterval,
	type TimeRotatingFileSinkOptions,
} from '@logtape/file'
import { getTextFormatter, type Sink } from '@logtape/logtape'
import { basename, dirname, extname } from 'pathe'
import { formatTextTimestamp } from './host'

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
	// LogTape's default "inspect" can throw for values like BigInt or circular structures.
	// This renderer is intentionally conservative: it must never throw.
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

function createSafeTextFormatter(timestamp: (ts: number) => string) {
	return getTextFormatter({
		timestamp,
		value: (v) => renderTextFormatterValue(v),
	})
}

export type PluxelDailyFileSinkOptions = {
	/** Max age for rotated files (ms). */
	maxAgeMs?: number
	/** Override text formatter. */
	formatter?: TimeRotatingFileSinkOptions['formatter']
	/** Rotation interval. @default "daily" */
	interval?: TimeRotationInterval
}

/**
 * Create a daily-rotating file sink from a "prefix path" (e.g. `./logs/app.log`)
 * expanded to `./logs/app-YYYY-MM-DD.log`.
 *
 * This is Node-only (uses `@logtape/file`).
 */
export function createDailyTimeRotatingFileSink(
	prefixPath: string,
	opts: PluxelDailyFileSinkOptions = {},
): Sink {
	const directory = dirname(prefixPath)
	const base = basename(prefixPath)
	const extRaw = extname(base)
	const ext = extRaw || '.log'
	const prefix = extRaw ? base.slice(0, -extRaw.length) : base

	return getTimeRotatingFileSink({
		directory,
		filename: prefix ? createDailyLogFilename(prefix, ext) : (d: Date) => `${formatDate(d)}${ext}`,
		interval: opts.interval ?? 'daily',
		maxAgeMs: opts.maxAgeMs,
		formatter: opts.formatter ?? createSafeTextFormatter((ts) => formatTextTimestamp(ts, 'utc')),
	})
}

export { getTimeRotatingFileSink, type TimeRotationInterval, type TimeRotatingFileSinkOptions }
