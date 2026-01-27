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

function isCategoryPrefixed(category: readonly string[], prefix: readonly string[]): boolean {
	if (prefix.length > category.length) return false
	for (let i = 0; i < prefix.length; i++) {
		if (category[i] !== prefix[i]) return false
	}
	return true
}

function formatMs(ms: unknown): string | undefined {
	if (typeof ms !== 'number' || !Number.isFinite(ms)) return undefined
	return `${ms.toFixed(1).replace(/\.0$/, '')}ms`
}

function formatHmrHotspots(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || value.length === 0) return undefined

	const lines: string[] = []
	lines.push('    hotspots:')
	for (const item of value) {
		if (!item || typeof item !== 'object') continue
		const id =
			typeof (item as { id?: unknown }).id === 'string'
				? ((item as { id: string }).id as string)
				: null
		const msText = formatMs((item as { ms?: unknown }).ms)
		if (!id || !msText) continue
		lines.push(`      - ${id} ${msText}`)
	}

	return lines.length > 1 ? lines : undefined
}

function formatHmrWarmupDetails(record: LogRecord): string[] | undefined {
	const props = record.properties as Record<string, unknown>

	const files = typeof props.files === 'number' ? props.files : undefined
	const scanMs = formatMs(props.scanMs)
	const warmupMs = formatMs(props.warmupMs)
	const commitMs = formatMs(props.commitMs)
	const totalMs = formatMs(props.totalMs)

	const lines: string[] = []

	const summaryParts: string[] = []
	if (files !== undefined) summaryParts.push(`files=${files}`)
	if (summaryParts.length) lines.push(`    ${summaryParts.join(' ')}`)

	const timeParts: string[] = []
	if (scanMs) timeParts.push(`scan=${scanMs}`)
	if (warmupMs) timeParts.push(`warmup=${warmupMs}`)
	if (commitMs) timeParts.push(`commit=${commitMs}`)
	if (totalMs) timeParts.push(`total=${totalMs}`)
	if (timeParts.length) lines.push(`    time: ${timeParts.join(' ')}`)

	const hotspots = formatHmrHotspots(props.hotspots)
	if (hotspots?.length) lines.push(...hotspots)

	return lines.length ? lines : undefined
}

function formatHmrUpdatedDetails(record: LogRecord): string[] | undefined {
	const props = record.properties as Record<string, unknown>

	const epoch = typeof props.epoch === 'number' ? props.epoch : undefined
	const changedFiles = typeof props.changedFiles === 'number' ? props.changedFiles : undefined
	const targets = typeof props.targets === 'number' ? props.targets : undefined
	const affected = typeof props.affected === 'number' ? props.affected : undefined
	const fallbackRoots = typeof props.fallbackRoots === 'number' ? props.fallbackRoots : undefined
	const activeServices = typeof props.activeServices === 'number' ? props.activeServices : undefined

	const batchMs = formatMs(props.batchMs)
	const commitMs = formatMs(props.commitMs)

	const plugins = props.plugins as unknown
	const pluginsLoaded =
		plugins &&
		typeof plugins === 'object' &&
		typeof (plugins as { loaded?: unknown }).loaded === 'number'
			? ((plugins as { loaded: number }).loaded as number)
			: undefined
	const pluginsEnabled =
		plugins &&
		typeof plugins === 'object' &&
		typeof (plugins as { enabled?: unknown }).enabled === 'number'
			? ((plugins as { enabled: number }).enabled as number)
			: undefined
	const pluginsRunning =
		plugins &&
		typeof plugins === 'object' &&
		typeof (plugins as { running?: unknown }).running === 'number'
			? ((plugins as { running: number }).running as number)
			: undefined

	const invalidated = props.invalidated as unknown
	const viteInvalidated =
		invalidated &&
		typeof invalidated === 'object' &&
		typeof (invalidated as { vite?: unknown }).vite === 'number'
			? ((invalidated as { vite: number }).vite as number)
			: undefined
	const runnerInvalidated =
		invalidated &&
		typeof invalidated === 'object' &&
		typeof (invalidated as { runner?: unknown }).runner === 'number'
			? ((invalidated as { runner: number }).runner as number)
			: undefined

	const lines: string[] = []

	const summaryParts: string[] = []
	if (epoch !== undefined) summaryParts.push(`epoch=${epoch}`)
	if (changedFiles !== undefined) summaryParts.push(`changed=${changedFiles}`)
	if (targets !== undefined) summaryParts.push(`targets=${targets}`)
	if (affected !== undefined) summaryParts.push(`affected=${affected}`)
	if (activeServices !== undefined) summaryParts.push(`services=${activeServices}`)
	if (fallbackRoots !== undefined) summaryParts.push(`roots=${fallbackRoots}`)
	if (summaryParts.length) lines.push(`    ${summaryParts.join(' ')}`)

	const timeParts: string[] = []
	if (batchMs) timeParts.push(`batch=${batchMs}`)
	if (commitMs) timeParts.push(`commit=${commitMs}`)
	if (timeParts.length) lines.push(`    time: ${timeParts.join(' ')}`)

	const pluginParts: string[] = []
	if (pluginsLoaded !== undefined) pluginParts.push(`loaded=${pluginsLoaded}`)
	if (pluginsEnabled !== undefined) pluginParts.push(`enabled=${pluginsEnabled}`)
	if (pluginsRunning !== undefined) pluginParts.push(`running=${pluginsRunning}`)
	if (pluginParts.length) lines.push(`    plugins: ${pluginParts.join(' ')}`)

	const invParts: string[] = []
	if (viteInvalidated !== undefined) invParts.push(`vite=${viteInvalidated}`)
	if (runnerInvalidated !== undefined) invParts.push(`runner=${runnerInvalidated}`)
	if (invParts.length) lines.push(`    invalidated: ${invParts.join(' ')}`)

	const hotspots = formatHmrHotspots(props.hotspots)
	if (hotspots?.length) lines.push(...hotspots)

	return lines.length ? lines : undefined
}

function formatHmrReportDetails(record: LogRecord): string[] | undefined {
	const props = record.properties as Record<string, unknown>

	const reason = typeof props.reason === 'string' ? props.reason : undefined
	const entries = typeof props.entries === 'number' ? props.entries : undefined
	const anchors = typeof props.anchors === 'number' ? props.anchors : undefined

	const builtins = props.builtins as unknown
	const builtinsLoaded =
		builtins &&
		typeof builtins === 'object' &&
		typeof (builtins as { loaded?: unknown }).loaded === 'number'
			? ((builtins as { loaded: number }).loaded as number)
			: undefined
	const builtinsEnabled =
		builtins &&
		typeof builtins === 'object' &&
		typeof (builtins as { enabled?: unknown }).enabled === 'number'
			? ((builtins as { enabled: number }).enabled as number)
			: undefined
	const builtinsRunning =
		builtins &&
		typeof builtins === 'object' &&
		typeof (builtins as { running?: unknown }).running === 'number'
			? ((builtins as { running: number }).running as number)
			: undefined

	const roots = props.roots as unknown
	const rootsList = Array.isArray(roots) ? roots : null

	const lines: string[] = []

	const headParts: string[] = []
	if (reason) headParts.push(`reason=${reason}`)
	if (rootsList) headParts.push(`roots=${rootsList.length}`)
	if (entries !== undefined) headParts.push(`entries=${entries}`)
	if (anchors !== undefined) headParts.push(`anchors=${anchors}`)
	if (
		builtinsLoaded !== undefined ||
		builtinsEnabled !== undefined ||
		builtinsRunning !== undefined
	) {
		headParts.push(
			`builtins=${builtinsLoaded ?? '?'}:${builtinsEnabled ?? '?'}:${builtinsRunning ?? '?'}`,
		)
	}
	if (headParts.length) lines.push(`    ${headParts.join(' ')}`)

	if (rootsList?.length) {
		lines.push('    roots:')
		for (const r of rootsList) {
			if (!r || typeof r !== 'object') continue
			const root =
				typeof (r as { root?: unknown }).root === 'string'
					? ((r as { root: string }).root as string)
					: null
			const rEntries =
				typeof (r as { entries?: unknown }).entries === 'number'
					? ((r as { entries: number }).entries as number)
					: undefined
			const loaded =
				typeof (r as { loaded?: unknown }).loaded === 'number'
					? ((r as { loaded: number }).loaded as number)
					: undefined
			const enabled =
				typeof (r as { enabled?: unknown }).enabled === 'number'
					? ((r as { enabled: number }).enabled as number)
					: undefined
			const running =
				typeof (r as { running?: unknown }).running === 'number'
					? ((r as { running: number }).running as number)
					: undefined

			if (!root) continue
			const parts: string[] = []
			if (rEntries !== undefined) parts.push(`entries=${rEntries}`)
			if (loaded !== undefined || enabled !== undefined || running !== undefined) {
				parts.push(`plugins=${loaded ?? '?'}:${enabled ?? '?'}:${running ?? '?'}`)
			}
			lines.push(`      - ${root}${parts.length ? ` ${parts.join(' ')}` : ''}`)
		}
	}

	const hotspots = formatHmrHotspots(props.hotspots)
	if (hotspots?.length) lines.push(...hotspots)

	return lines.length ? lines : undefined
}

function formatHmrPrettyDetails(record: LogRecord): string[] | undefined {
	if (!isCategoryPrefixed(record.category, pluxelCategories.hmr)) return undefined

	const head = String(record.message[0] ?? '')
	if (head.includes('HMR warmup done')) return formatHmrWarmupDetails(record)
	if (head.includes('HMR updated')) return formatHmrUpdatedDetails(record)
	if (head.includes('HMR report')) return formatHmrReportDetails(record)
	return undefined
}

function formatExtraPropsInline(record: LogRecord, colorsOn: boolean): string | undefined {
	const entries = collectExtraProps(record)
	if (!entries.length) return undefined

	// Keep one-line logs dense: only inline when short and few keys.
	const kvEntries = entries.filter(
		(e): e is Extract<ExtraPropEntry, { kind: 'kv' }> => e.kind === 'kv',
	)
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
		const hmrLines = !multiline ? formatHmrPrettyDetails(nextRecord) : undefined
		if (hmrLines?.length) {
			out = `${out}\n${hmrLines.join('\n')}`
			usedBlock = true
		} else {
			const inline = !multiline ? formatExtraPropsInline(nextRecord, colorsOn) : undefined
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
	type CategoryColorKey = CategoryColorMap extends Map<infer K, unknown> ? K : never
	type CategoryColorValue = CategoryColorMap extends Map<unknown, infer V> ? V : never

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
