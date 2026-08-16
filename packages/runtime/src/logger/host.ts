import { isAbsolute, relative } from 'pathe'

const RESERVED_PROPERTY_KEYS = new Set(['plugin', 'context', 'name', 'caller'])
const CALLER_SKIP_MARKERS = [
	'/node_modules/@logtape/',
	'\\node_modules\\@logtape\\',
	'/packages/runtime/src/logger/',
	'\\packages\\runtime\\src\\logger\\',
]

export function isReservedLogProperty(key: string): boolean {
	return RESERVED_PROPERTY_KEYS.has(key)
}

export function formatLogName(context: string, pluginLabel?: string): string {
	if (!pluginLabel || pluginLabel === context) return context
	return `${pluginLabel}(${context})`
}

export function captureCaller(): string | undefined {
	const stack = new Error('capture caller stack').stack
	if (!stack) return undefined
	for (const raw of stack.split('\n').slice(1)) {
		const line = raw.trim()
		if (!line.startsWith('at ') || CALLER_SKIP_MARKERS.some((marker) => line.includes(marker))) {
			continue
		}
		const match =
			line.match(/^at\s+(.*?)\s+\((.*?):(\d+):(\d+)\)$/) ?? line.match(/^at\s+(.*?):(\d+):(\d+)$/)
		if (!match) continue
		if (match.length === 5) {
			return `${normalizeFunctionName(match[1]!)} (${displayPath(match[2]!)}:${match[3]}:${match[4]})`
		}
		return `${displayPath(match[1]!)}:${match[2]}:${match[3]}`
	}
	return undefined
}

function displayPath(file: string): string {
	const normalized = file.startsWith('file://') ? file.slice('file://'.length) : file
	if (!isAbsolute(normalized)) return normalized
	try {
		const value = relative(process.cwd(), normalized)
		return !value || value.startsWith('..') ? normalized : value
	} catch {
		return normalized
	}
}

function normalizeFunctionName(value: string): string {
	return value.replace(/^async\s+/, '').replace(/^(?:Object|Module|Function)\./, '')
}

function pad(value: number, size = 2): string {
	return String(value).padStart(size, '0')
}

export function formatPrettyTimestamp(timestamp: number, timezone: 'local' | 'utc'): string {
	const date = new Date(timestamp)
	return timezone === 'utc'
		? `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
		: `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export function formatTextTimestamp(timestamp: number, timezone: 'local' | 'utc'): string {
	const date = new Date(timestamp)
	if (timezone === 'utc') return date.toISOString().replace('T', ' ').replace('Z', ' +00:00')
	const offset = -date.getTimezoneOffset()
	const sign = offset >= 0 ? '+' : '-'
	const absolute = Math.abs(offset)
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)} ${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`
}
