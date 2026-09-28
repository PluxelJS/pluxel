import {
	getTimeRotatingFileSink,
	type TimeRotationInterval,
	type TimeRotatingFileSinkOptions,
} from '@logtape/file'
import { getTextFormatter } from '@logtape/logtape'
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
) {
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
		formatter:
			opts.formatter ?? getTextFormatter({ timestamp: (ts) => formatTextTimestamp(ts, 'utc') }),
	})
}

export { getTimeRotatingFileSink, type TimeRotationInterval, type TimeRotatingFileSinkOptions }
