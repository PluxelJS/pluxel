import { readEnv } from './runtime'

export type PluxelLogTimezone = 'local' | 'utc'

function pad2(n: number): string {
	return String(n).padStart(2, '0')
}

function pad3(n: number): string {
	return String(n).padStart(3, '0')
}

export function resolvePluxelLogTimezone(): PluxelLogTimezone {
	const raw = (readEnv('PLUXEL_LOG_TZ') ?? readEnv('PLUXEL_LOG_TIMEZONE'))?.trim().toLowerCase()
	if (!raw) return 'local'
	if (raw === 'utc') return 'utc'
	if (raw === 'local') return 'local'
	return 'local'
}

export function resolvePluxelLogFileTimezone(): PluxelLogTimezone {
	const raw = (readEnv('PLUXEL_LOG_FILE_TZ') ?? readEnv('PLUXEL_LOG_FILE_TIMEZONE'))
		?.trim()
		.toLowerCase()
	if (!raw) return 'utc'
	if (raw === 'utc') return 'utc'
	if (raw === 'local') return 'local'
	return 'utc'
}

export function formatLocalTime(ts: number): string {
	const d = new Date(ts)
	return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

export function formatUtcTime(ts: number): string {
	const iso = new Date(ts).toISOString()
	return iso.replace(/.*T/, '').replace('Z', '').slice(0, 8)
}

/**
 * Local timestamp roughly matching LogTape's default text formatter:
 * `YYYY-MM-DD HH:MM:SS.mmm ±HH:MM`.
 */
export function formatLocalDateTimeTimezone(ts: number): string {
	const d = new Date(ts)
	const yyyy = d.getFullYear()
	const mm = pad2(d.getMonth() + 1)
	const dd = pad2(d.getDate())
	const hh = pad2(d.getHours())
	const mi = pad2(d.getMinutes())
	const ss = pad2(d.getSeconds())
	const ms = pad3(d.getMilliseconds())

	const offsetMinutes = -d.getTimezoneOffset()
	const sign = offsetMinutes >= 0 ? '+' : '-'
	const abs = Math.abs(offsetMinutes)
	const offH = pad2(Math.floor(abs / 60))
	const offM = pad2(abs % 60)

	return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}.${ms} ${sign}${offH}:${offM}`
}

export function formatUtcDateTimeTimezone(ts: number): string {
	const iso = new Date(ts).toISOString()
	return iso.replace('T', ' ').replace('Z', ' +00:00')
}

export function createPluxelPrettyTimestampFormatter(
	tz: PluxelLogTimezone = resolvePluxelLogTimezone(),
): (ts: number) => string {
	return tz === 'utc' ? formatUtcTime : formatLocalTime
}

export function createPluxelTextTimestampFormatter(
	tz: PluxelLogTimezone = resolvePluxelLogFileTimezone(),
): (ts: number) => string {
	return tz === 'utc' ? formatUtcDateTimeTimezone : formatLocalDateTimeTimezone
}

export function pluxelPrettyTimestamp(ts: number): string {
	return resolvePluxelLogTimezone() === 'utc' ? formatUtcTime(ts) : formatLocalTime(ts)
}

export function pluxelTextTimestamp(ts: number): string {
	return resolvePluxelLogFileTimezone() === 'utc'
		? formatUtcDateTimeTimezone(ts)
		: formatLocalDateTimeTimezone(ts)
}
