import type { LogRecord, TextFormatter } from '@logtape/logtape'
import { getPrettyFormatter, type PrettyFormatterOptions } from '@logtape/pretty'
import { captureCaller, isCallerEnabled } from './caller'
import { pluxelCategories } from './categories'
import { formatErrorStack } from './error'

export type PluxelPrefixOptions = {
	/**
	 * Prefix strategy:
	 * - `"name"`: use `record.properties.name` when available (hmr), else derive from pluginId/context
	 * - `"context"`: use pluginId/context only
	 * - `"category"`: fall back to category display
	 */
	prefix?: 'name' | 'context' | 'category'
	/**
	 * If true, append caller info to the rendered message.
	 *
	 * Rules:
	 * - If `record.properties.caller` is a string, use it.
	 * - Otherwise (and when enabled via {@link isCallerEnabled}), capture a stack frame at render time.
	 */
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
		typeof record.properties.pluginId === 'string'
			? (record.properties.pluginId as string)
			: undefined
	const context =
		typeof record.properties.context === 'string'
			? (record.properties.context as string)
			: undefined
	const name =
		typeof record.properties.name === 'string' ? (record.properties.name as string) : undefined

	if (mode === 'name' && name) return `[${name}]`
	if (pluginId && context) return `[${pluginId}:${context}]`
	if (context) return `[${context}]`
	return `[${record.category.join(':')}]`
}

function formatDebugTag(debugTopic: string): string {
	const t = debugTopic.startsWith('pluxel:') ? debugTopic.slice('pluxel:'.length) : debugTopic
	return `{dbg:${t}}`
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
	if (typeof value === 'string') return value.length > 2000 ? `${value.slice(0, 2000)}…` : value
	if (typeof value === 'number' || typeof value === 'boolean') return value
	if (typeof value === 'bigint') return `${value}n`
	if (typeof value === 'undefined') return undefined
	if (typeof value === 'symbol') return value.toString()
	if (typeof value === 'function') {
		const name =
			typeof (value as { name?: unknown }).name === 'string' ? (value as { name: string }).name : ''
		return `[Function ${name || 'anonymous'}]`
	}

	if (value instanceof Error) {
		const errorLike = value as unknown as Error & Record<string, unknown> & { cause?: unknown }
		const extra: Record<string, unknown> = {}
		for (const [k, v] of Object.entries(errorLike)) {
			extra[k] = toPlainValue(v, depth - 1, seen)
		}
		return {
			name: value.name,
			message: value.message,
			stack: toPlainValue(value.stack, depth - 1, seen),
			cause: errorLike.cause ? toPlainValue(errorLike.cause, depth - 1, seen) : undefined,
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

type ExtraPropEntry =
	| { kind: 'kv'; key: string; value: string }
	| { kind: 'block'; key: string; lines: string[] }

function collectExtraProps(record: LogRecord): ExtraPropEntry[] {
	const props = record.properties as Record<string, unknown>

	const entries: ExtraPropEntry[] = []
	for (const [k, v] of Object.entries(props)) {
		if (k === 'context' || k === 'pluginId' || k === 'name' || k === 'caller' || k === 'debugTopic')
			continue
		if (v === undefined) continue

		if ((k === 'error' || k === 'err') && v instanceof Error) {
			entries.push({ kind: 'block', key: k, lines: formatErrorStack(v).split('\n') })
			continue
		}

		if (Array.isArray(v) && v.every((x) => typeof x === 'string')) {
			const list = v as string[]
			entries.push({ kind: 'kv', key: `${k}(${list.length})`, value: formatCompactValue(list) })
			continue
		}

		entries.push({ kind: 'kv', key: k, value: formatCompactValue(v) })
	}

	entries.sort((a, b) => {
		if (a.kind !== b.kind) return a.kind === 'block' ? 1 : -1
		return a.key.localeCompare(b.key)
	})
	return entries
}

function colorizeExtraKey(keyText: string, colorsOn: boolean): string {
	if (!colorsOn) return keyText
	const reset = '\u001B[0m'
	const key = '\u001B[38;2;125;211;252m' // sky-ish
	return `${key}${keyText}${reset}`
}

function colorizeExtraPair(keyText: string, valueText: string, colorsOn: boolean): string {
	if (!colorsOn) return `${keyText}=${valueText}`
	const reset = '\u001B[0m'
	const dim = '\u001B[2m'
	const val = '\u001B[38;2;253;224;71m' // amber-ish
	return `${colorizeExtraKey(keyText, true)}${dim}=${reset}${val}${valueText}${reset}`
}

function stripAnsi(text: string): string {
	let out = ''
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) !== 0x1b || text[i + 1] !== '[') {
			out += text[i]
			continue
		}

		// Skip SGR codes: ESC [ ... m
		i += 2
		while (i < text.length) {
			const c = text.charCodeAt(i)
			if ((c >= 0x30 && c <= 0x39) || c === 0x3b) {
				i += 1
				continue
			}
			if (text[i] === 'm') {
				break
			}
			break
		}
	}
	return out
}

function formatExtraPropsInline(record: LogRecord, colorsOn: boolean): string | undefined {
	const entries = collectExtraProps(record)
	if (!entries.length) return undefined

	// Keep one-line logs dense: only inline when short and few keys.
	const kvEntries = entries.filter((e): e is Extract<ExtraPropEntry, { kind: 'kv' }> => e.kind === 'kv')
	if (kvEntries.length !== entries.length) return undefined
	if (kvEntries.length > 2) return undefined

	const open = '⟪'
	const close = '⟫'
	const brace = colorsOn ? '\u001B[38;2;148;163;184m' : ''
	const reset = colorsOn ? '\u001B[0m' : ''

	const body = kvEntries
		.map((e) => colorizeExtraPair(e.key, e.value, colorsOn))
		.join(colorsOn ? `${reset} ` : ' ')
	const rendered = `${brace}${open}${reset}${body}${brace}${close}${reset}`
	if (stripAnsi(rendered).length > 60) return undefined
	return ` ${rendered}`
}

function formatExtraPropsBlock(record: LogRecord, colorsOn: boolean): string[] | undefined {
	const entries = collectExtraProps(record)
	if (!entries.length) return undefined

	const open = '⟪'
	const close = '⟫'
	const brace = colorsOn ? '\u001B[38;2;148;163;184m' : ''
	const reset = colorsOn ? '\u001B[0m' : ''

	const lines: string[] = []
	for (const e of entries) {
		if (e.kind === 'kv') {
			lines.push(
				`    ${brace}${open}${reset}${colorizeExtraPair(e.key, e.value, colorsOn)}${brace}${close}${reset}`,
			)
			continue
		}

		lines.push(
			`    ${brace}${open}${reset}${colorizeExtraKey(e.key, colorsOn)}${brace}${close}${reset}`,
		)
		for (const l of e.lines) {
			lines.push(`      ${l}`)
		}
	}
	return lines
}

function normalizeMessageForConsole(message: readonly unknown[]): unknown[] {
	// Runtime-agnostic fix for quoted string values:
	// LogTape represents template messages as [str, val, str, val, ...].
	// If `val` is a string, merge it into the surrounding string parts so it
	// becomes part of the message text (instead of going through value rendering).
	const parts = Array.from(message)

	for (let i = 1; i < parts.length; i += 2) {
		const v = parts[i]
		if (typeof v !== 'string') continue

		const prev = parts[i - 1]
		const next = parts[i + 1]
		if (typeof prev !== 'string' || typeof next !== 'string') continue

		parts[i - 1] = `${prev}${v}${next}`
		parts.splice(i, 2) // remove value + following string
		i -= 2
	}

	return parts
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

	const formatter: TextFormatter = (record) => {
		const prefix = buildPrefix(record, mode)
		// Do not mutate `record.message` in-place: LogTape fan-outs the same record to multiple sinks.
		const message = normalizeMessageForConsole(record.message)
		const debugTopic =
			record.level === 'debug' && typeof record.properties.debugTopic === 'string'
				? (record.properties.debugTopic as string)
				: undefined
		const debugTag = debugTopic ? ` ${formatDebugTag(debugTopic)}` : ''
		message[0] = `${prefix}${debugTag} ${String(message[0] ?? '')}`

		const caller =
			includeCaller && isCallerEnabled()
				? typeof record.properties.caller === 'string'
					? (record.properties.caller as string)
					: captureCaller({ exclude: formatter })
				: undefined

		const nextRecord = { ...record, message } as LogRecord

		let out = stripTrailingNewlines(base(nextRecord))
		const colorsOn = out.includes('\u001B[')
		const multiline = out.includes('\n')
		let usedBlock = false
		const inline = !multiline ? formatExtraPropsInline(nextRecord, colorsOn) : undefined
		if (inline) out = `${out}${inline}`
		else {
			const lines = formatExtraPropsBlock(nextRecord, colorsOn)
			if (lines?.length) {
				out = `${out}\n${lines.join('\n')}`
				usedBlock = true
			}
		}
		if (caller) {
			const callerSuffix = formatCallerSuffix(callerMarker, caller, colorsOn)
			out =
				usedBlock || multiline ? `${out}\n    ${callerSuffix.trimStart()}` : `${out}${callerSuffix}`
		}

		// Only add extra styling when the base formatter already emits ANSI.
		const styled = colorsOn ? colorizeHmrAttribution(out) : out
		return styled
	}

	return formatter
}

export type PluxelPrettyFormatterOptions = PrettyFormatterOptions & PluxelPrefixOptions

export function createPluxelPrettyFormatter(
	opts: PluxelPrettyFormatterOptions = {},
): TextFormatter {
	const { prefix, includeCaller, ...prettyOpts } = opts

	// Better defaults for dark terminals:
	// - Avoid "dim gray" for timestamps/category/message which is unreadable on many themes.
	type CategoryColorMap = NonNullable<PrettyFormatterOptions['categoryColorMap']>
	type CategoryColorKey = CategoryColorMap extends Map<infer K, any> ? K : never
	type CategoryColorValue = CategoryColorMap extends Map<any, infer V> ? V : never

	const categoryColorMap: CategoryColorMap =
		prettyOpts.categoryColorMap ??
		new Map<CategoryColorKey, CategoryColorValue>([
			[pluxelCategories.core as unknown as CategoryColorKey, 'cyan' as CategoryColorValue],
			[pluxelCategories.hmr as unknown as CategoryColorKey, 'magenta' as CategoryColorValue],
			[pluxelCategories.plugins as unknown as CategoryColorKey, 'yellow' as CategoryColorValue],
			[['pluxel'] as unknown as CategoryColorKey, 'blue' as CategoryColorValue],
		])

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
