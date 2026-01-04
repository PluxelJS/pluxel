import {
	type ConsoleFormatter,
	type LogRecord,
	type TextFormatter,
} from '@logtape/logtape'
import { getPrettyFormatter, type PrettyFormatterOptions } from '@logtape/pretty'

import { pluxelCategories } from './categories'

export type PluxelPrettyOptions = {
	includeTimestamp?: boolean
	includeCaller?: boolean
}

function formatMessage(record: LogRecord): { fmt: string; values: unknown[] } {
	let msg = ''
	const values: unknown[] = []
	for (let i = 0; i < record.message.length; i++) {
		if (i % 2 === 0) msg += String(record.message[i] ?? '')
		else {
			const v = record.message[i]
			// Avoid quoting strings (util.format(%o) would show "'text'").
			if (typeof v === 'string') {
				msg += '%s'
				values.push(v)
			} else {
				msg += '%o'
				values.push(v)
			}
		}
	}
	return { fmt: msg, values }
}

/**
 * Legacy console formatter (kept for compatibility).
 * Prefer {@link createPluxelPrettyFormatter} for local development.
 */
export function createPluxelConsoleFormatter(
	opts: PluxelPrettyOptions = {},
): ConsoleFormatter {
	const includeTimestamp = opts.includeTimestamp ?? true
	const includeCaller = opts.includeCaller ?? true
	const callerMarker = '⤷'

	return (record) => {
		const time = includeTimestamp ? `${new Date(record.timestamp).toISOString()} ` : ''
		const level = record.level.toUpperCase()

		const pluginId =
			typeof record.properties.pluginId === 'string' ? (record.properties.pluginId as string) : ''
		const context =
			typeof record.properties.context === 'string' ? (record.properties.context as string) : ''
		const prefix = pluginId
			? `[${pluginId}:${context}]`
			: context
				? `[${context}]`
				: `[${record.category.join(':')}]`

		const { fmt, values } = formatMessage(record)
		const caller =
			includeCaller && typeof record.properties.caller === 'string'
				? (record.properties.caller as string)
				: undefined
		const callerSuffix = caller ? ` ${callerMarker} ${caller}` : ''

		return [`${time}${level} ${prefix} ${fmt}${callerSuffix}`, ...values]
	}
}

export type PluxelPrefixOptions = {
	/**
	 * Prefix strategy:
	 * - `"name"`: use `record.properties.name` when available (hmr), else derive from pluginId/context
	 * - `"context"`: use pluginId/context only
	 * - `"category"`: fall back to category display
	 */
	prefix?: 'name' | 'context' | 'category'
	/** If true, append `record.properties.caller` when present. */
	includeCaller?: boolean
	/**
	 * Suffix marker used for `caller` display (pretty only).
	 * Keep it subtle and visually distinct from message text.
	 * @default "⤷"
	 */
	callerMarker?: string
}

function buildPrefix(record: LogRecord, mode: PluxelPrefixOptions['prefix']): string {
	const pluginId =
		typeof record.properties.pluginId === 'string' ? (record.properties.pluginId as string) : undefined
	const context =
		typeof record.properties.context === 'string' ? (record.properties.context as string) : undefined
	const name =
		typeof record.properties.name === 'string' ? (record.properties.name as string) : undefined

	if (mode === 'name' && name) return `[${name}]`
	if (pluginId && context) return `[${pluginId}:${context}]`
	if (context) return `[${context}]`
	return `[${record.category.join(':')}]`
}

function appendSuffix(message: unknown[], suffix: string): unknown[] {
	if (message.length === 0) return [suffix]
	const last = message.length - 1
	if (last % 2 === 0 && typeof message[last] === 'string') {
		const next = message.slice()
		next[last] = `${next[last]}${suffix}`
		return next
	}
	return [...message, suffix]
}

function formatCallerSuffix(marker: string, caller: string, colorsOn: boolean): string {
	const suffix = `${marker} ${caller}`
	if (!colorsOn) return ` ${suffix}`
	// `@logtape/pretty` already emits ANSI when colors are on; keep caller subtle.
	const reset = '\u001B[0m'
	const italic = '\u001B[3m'
	const color = '\u001B[38;2;148;163;184m' // readable "slate" on dark backgrounds
	return ` ${italic}${color}${suffix}${reset}`
}

function colorizeHmrAttribution(text: string): string {
	// Apply subtle colors to improve scan-ability in console output.
	if (!text.includes('[HMR] attribution:')) return text

	const reset = '\u001B[0m'
	const dim = '\u001B[2m'
	const cyan = '\u001B[36m'
	const yellow = '\u001B[33m'
	const magenta = '\u001B[35m'
	const blue = '\u001B[34m'

	// ms column
	let out = text.replace(/\b(\d+(?:\.\d+)?)ms\b/g, `${cyan}$1ms${reset}`)

	// tags
	out = out.replace(/\btarget\b/g, `${yellow}target${reset}`)
	out = out.replace(/\bchanged\b/g, `${magenta}changed${reset}`)
	out = out.replace(/\(none\)/g, `${dim}(none)${reset}`)

	// paths (keep this conservative to avoid coloring unrelated words)
	out = out.replace(
		/(^|\s)([A-Za-z0-9_./-]+?\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts))(?=$|\s|[:)])/g,
		(_m, p1: string, p2: string) => `${p1}${blue}${p2}${reset}`,
	)

	return out
}

function stripTrailingNewlines(text: string): string {
	return text.replace(/\n+$/g, '')
}

function toPlainValue(value: unknown, depth = 3, seen = new WeakSet<object>()): unknown {
	if (depth < 0) return '[MaxDepth]'
	if (value === null) return null
	const t = typeof value
	if (t === 'string') return value.length > 2000 ? `${value.slice(0, 2000)}…` : value
	if (t === 'number' || t === 'boolean') return value
	if (t === 'bigint') return `${value}n`
	if (t === 'undefined') return undefined
	if (t === 'symbol') return value.toString()
	if (t === 'function') return `[Function ${(value as Function).name || 'anonymous'}]`

	if (value instanceof Error) {
		const extra: Record<string, unknown> = {}
		for (const [k, v] of Object.entries(value as any)) {
			extra[k] = toPlainValue(v, depth - 1, seen)
		}
		return {
			name: value.name,
			message: value.message,
			stack: value.stack,
			cause: (value as any).cause ? toPlainValue((value as any).cause, depth - 1, seen) : undefined,
			...extra,
		}
	}

	if (value instanceof Date) return value.toISOString()
	if (value instanceof URL) return value.toString()

	if (Array.isArray(value)) {
		const limit = Math.min(value.length, 100)
		return value.slice(0, limit).map((v) => toPlainValue(v, depth - 1, seen))
	}

	if (value instanceof Map) {
		const entries: Array<[unknown, unknown]> = []
		let count = 0
		for (const [k, v] of value) {
			if (count++ >= 100) break
			entries.push([toPlainValue(k, depth - 1, seen), toPlainValue(v, depth - 1, seen)])
		}
		return { type: 'Map', size: value.size, entries }
	}

	if (value instanceof Set) {
		const values: unknown[] = []
		let count = 0
		for (const v of value) {
			if (count++ >= 100) break
			values.push(toPlainValue(v, depth - 1, seen))
		}
		return { type: 'Set', size: value.size, values }
	}

	if (typeof value === 'object') {
		const obj = value as object
		if (seen.has(obj)) return '[Circular]'
		seen.add(obj)

		const out: Record<string, unknown> = {}
		let count = 0
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			if (count++ >= 100) break
			out[k] = toPlainValue(v, depth - 1, seen)
		}
		return out
	}

	return String(value)
}

function formatCompactValue(value: unknown): string {
	if (typeof value === 'string') return value
	if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint')
		return String(value)

	if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
		const list = value as string[]
		const compact = list.map((s) => {
			// "PluginB(PluginB)" → "PluginB", "DemoClock.System(DemoClockSystem)" → "DemoClock.System"
			const m = s.match(/^(.+)\([^)]*\)$/)
			return m ? m[1] : s
		})
		const limit = 6
		const head = compact.slice(0, limit).join(', ')
		return compact.length > limit ? `[${head}, …(+${compact.length - limit})]` : `[${head}]`
	}

	try {
		return JSON.stringify(toPlainValue(value), null, 0) ?? String(value)
	} catch {
		return String(value)
	}
}

type ExtraPropEntry = { key: string; value: string }

function collectExtraProps(record: LogRecord): ExtraPropEntry[] {
	const props = record.properties as Record<string, unknown>

	const entries: ExtraPropEntry[] = []
	for (const [k, v] of Object.entries(props)) {
		if (k === 'context' || k === 'pluginId' || k === 'name' || k === 'caller') continue
		// Let Youch own the error rendering; keep error metadata minimal here.
		if (k === 'error' || k === 'err') continue
		if (v === undefined) continue

		if (Array.isArray(v) && v.every((x) => typeof x === 'string')) {
			const list = v as string[]
			entries.push({ key: `${k}(${list.length})`, value: formatCompactValue(list) })
			continue
		}

		entries.push({ key: k, value: formatCompactValue(v) })
	}

	entries.sort((a, b) => a.key.localeCompare(b.key))
	return entries
}

function colorizeExtraPair(pair: ExtraPropEntry, colorsOn: boolean): string {
	const { key: k, value: v } = pair
	if (!colorsOn) return `${k}=${v}`
	const reset = '\u001B[0m'
	const dim = '\u001B[2m'
	const key = '\u001B[38;2;125;211;252m' // sky-ish
	const val = '\u001B[38;2;253;224;71m' // amber-ish
	return `${key}${k}${reset}${dim}=${reset}${val}${v}${reset}`
}

function formatExtraPropsInline(record: LogRecord, colorsOn: boolean): string | undefined {
	const entries = collectExtraProps(record)
	if (!entries.length) return undefined

	// Keep one-line logs dense: only inline when short and few keys.
	if (entries.length > 2) return undefined

	const open = '⟪'
	const close = '⟫'
	const brace = colorsOn ? '\u001B[38;2;148;163;184m' : ''
	const reset = colorsOn ? '\u001B[0m' : ''

	const body = entries.map((e) => colorizeExtraPair(e, colorsOn)).join(colorsOn ? `${reset} ` : ' ')
	const rendered = `${brace}${open}${reset}${body}${brace}${close}${reset}`
	if (rendered.replace(/\u001B\[[0-9;]*m/g, '').length > 60) return undefined
	return ` ${rendered}`
}

function formatExtraPropsBlock(record: LogRecord, colorsOn: boolean): string[] | undefined {
	const entries = collectExtraProps(record)
	if (!entries.length) return undefined

	const open = '⟪'
	const close = '⟫'
	const brace = colorsOn ? '\u001B[38;2;148;163;184m' : ''
	const reset = colorsOn ? '\u001B[0m' : ''

	return entries.map((e) => `    ${brace}${open}${reset}${colorizeExtraPair(e, colorsOn)}${brace}${close}${reset}`)
}

function normalizeMessageForConsole(message: unknown[]): unknown[] {
	// Runtime-agnostic fix for quoted string values:
	// LogTape represents template messages as [str, val, str, val, ...].
	// If `val` is a string, merge it into the surrounding string parts so it
	// becomes part of the message text (instead of going through value rendering).
	const parts = message.slice()
	let changed = false

	for (let i = 1; i < parts.length; i += 2) {
		const v = parts[i]
		if (typeof v !== 'string') continue

		const prev = parts[i - 1]
		const next = parts[i + 1]
		if (typeof prev !== 'string' || typeof next !== 'string') continue

		parts[i - 1] = `${prev}${v}${next}`
		parts.splice(i, 2) // remove value + following string
		i -= 2
		changed = true
	}

	return changed ? parts : message
}

/**
 * Wrap a {@link TextFormatter} to inject a pluxel-friendly prefix and caller
 * into the message, keeping structured properties intact.
 */
export function withPluxelMessagePrefix(
	base: TextFormatter,
	opts: PluxelPrefixOptions = {},
): TextFormatter {
	const mode = opts.prefix ?? 'name'
	const includeCaller = opts.includeCaller ?? true
	const callerMarker = opts.callerMarker ?? '⤷'

	return (record) => {
		const prefix = buildPrefix(record, mode)
		// Do not mutate `record.message` in-place: LogTape fan-outs the same record to multiple sinks.
		const normalized = normalizeMessageForConsole(record.message)
		const message = normalized === record.message ? record.message.slice() : normalized
		message[0] = `${prefix} ${String(message[0] ?? '')}`

		const caller =
			includeCaller && typeof record.properties.caller === 'string'
				? (record.properties.caller as string)
				: undefined

		const nextRecord = { ...record, message } as LogRecord

		let out = stripTrailingNewlines(base(nextRecord))
		const colorsOn = out.includes('\u001B[')
		let usedBlock = false
		if (!out.includes('\n')) {
			const inline = formatExtraPropsInline(nextRecord, colorsOn)
			if (inline) out = `${out}${inline}`
			else {
				const lines = formatExtraPropsBlock(nextRecord, colorsOn)
				if (lines?.length) {
					out = `${out}\n${lines.join('\n')}`
					usedBlock = true
				}
			}
		}
		if (caller) {
			const callerSuffix = formatCallerSuffix(callerMarker, caller, colorsOn)
			out = usedBlock ? `${out}\n    ${callerSuffix.trimStart()}` : `${out}${callerSuffix}`
		}

		// Only add extra styling when the base formatter already emits ANSI.
		const styled = colorsOn ? colorizeHmrAttribution(out) : out
		return styled
	}
}

export type PluxelPrettyFormatterOptions = PrettyFormatterOptions & PluxelPrefixOptions

export function createPluxelPrettyFormatter(
	opts: PluxelPrettyFormatterOptions = {},
): TextFormatter {
	const { prefix, includeCaller, ...prettyOpts } = opts

	// Better defaults for dark terminals:
	// - Avoid "dim gray" for timestamps/category/message which is unreadable on many themes.
	const categoryColorMap =
		prettyOpts.categoryColorMap ??
		(new Map([
			[pluxelCategories.core, 'cyan'],
			[pluxelCategories.hmr, 'magenta'],
			[pluxelCategories.plugins, 'yellow'],
			[['pluxel'], 'blue'],
		]) as NonNullable<PrettyFormatterOptions['categoryColorMap']>)

	const normalized: PrettyFormatterOptions = {
		...prettyOpts,
		timestampColor: prettyOpts.timestampColor ?? null,
		timestampStyle: prettyOpts.timestampStyle ?? null,
		categoryColor: prettyOpts.categoryColor ?? null,
		categoryStyle: prettyOpts.categoryStyle ?? null,
		messageColor: prettyOpts.messageColor ?? null,
		messageStyle: prettyOpts.messageStyle ?? null,
		categoryColorMap,
	}

	const base = getPrettyFormatter(normalized)

	return withPluxelMessagePrefix(base, { prefix, includeCaller })
}
