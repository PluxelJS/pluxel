import type { RuntimeLogLine } from './protocol'

export type LlmLogFormatOptions = {
	/** Maximum total characters for the formatted output. Defaults to 6000. */
	maxChars?: number
	/** Maximum characters per rendered line (hard cap). Defaults to 500. */
	maxLineChars?: number
	/** Maximum stack lines to include for error-like props. Defaults to 6. */
	maxStackLines?: number
	/** Include category prefix (e.g. pluxel.plugins). Defaults to true. */
	includeCategory?: boolean
	/** Include plugin/context/name hint. Defaults to true. */
	includeOrigin?: boolean
	/** Include selected structured props (errors + a few useful keys). Defaults to true. */
	includeProps?: boolean
}

export type LlmLogsText = {
	text: string
	count: number
	truncated: boolean
}

const DEFAULTS: Required<LlmLogFormatOptions> = {
	maxChars: 6000,
	maxLineChars: 500,
	maxStackLines: 6,
	includeCategory: true,
	includeOrigin: true,
	includeProps: true,
}

function clampInt(n: unknown, fallback: number, min: number, max: number) {
	if (typeof n !== 'number' || !Number.isFinite(n)) return fallback
	const v = Math.floor(n)
	return Math.min(max, Math.max(min, v))
}

function toIsoTime(ms: number) {
	try {
		return new Date(ms).toISOString()
	} catch {
		return String(ms)
	}
}

function truncate(s: string, max: number) {
	if (s.length <= max) return s
	return `${s.slice(0, Math.max(0, max - 1))}…`
}

function isErrorLike(
	v: unknown,
): v is { name?: unknown; message?: unknown; stack?: unknown; cause?: unknown } {
	return !!v && typeof v === 'object'
}

function formatErrorLike(v: unknown, maxStackLines: number) {
	if (!isErrorLike(v)) return null
	const name = typeof v.name === 'string' ? v.name : 'Error'
	const message = typeof v.message === 'string' ? v.message : ''
	const head = message ? `${name}: ${message}` : name
	const stackRaw = typeof v.stack === 'string' ? v.stack : ''
	if (!stackRaw) return head
	const lines = stackRaw
		.split('\n')
		.map((l) => l.trim())
		.filter(Boolean)
	if (lines.length === 0) return head
	const limited = lines.slice(0, Math.max(1, maxStackLines)).join('\n')
	return `${head}\n${limited}`
}

function formatMessageParts(record: RuntimeLogLine, maxPartChars: number) {
	const parts = Array.isArray(record.message) ? record.message : null
	if (!parts || parts.length === 0) return truncate(record.msg ?? '', maxPartChars)

	const out: string[] = []
	for (const p of parts) {
		if (p === null) {
			out.push('null')
			continue
		}
		if (p === undefined) continue
		if (typeof p === 'string') {
			out.push(p)
			continue
		}
		if (typeof p === 'number' || typeof p === 'boolean' || typeof p === 'bigint') {
			out.push(String(p))
			continue
		}
		if (p instanceof Date) {
			out.push(p.toISOString())
			continue
		}
		// Objects are already JSON-sanitized by the UI sink; still keep it compact for LLM.
		try {
			const json = JSON.stringify(p)
			out.push(json === undefined ? '[Object]' : json)
		} catch {
			out.push('[Object]')
		}
	}

	return truncate(out.join(''), maxPartChars)
}

function formatSelectedProps(record: RuntimeLogLine, maxStackLines: number) {
	const props = record.props
	if (!props || typeof props !== 'object') return null

	const out: string[] = []

	// Always prioritize error-like fields.
	for (const k of ['error', 'err', 'cause'] as const) {
		if (!(k in props)) continue
		const formatted = formatErrorLike((props as any)[k], maxStackLines)
		if (formatted) out.push(formatted)
	}

	// Add a minimal set of high-signal keys (stable + common).
	for (const key of ['code', 'status', 'path', 'method', 'pluginName', 'namespace'] as const) {
		const v = (props as any)[key]
		if (v === undefined || v === null) continue
		if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
			out.push(`${key}=${String(v)}`)
		}
	}

	if (out.length === 0) return null
	return out.join('\n')
}

export function formatUiLogRecordForLlm(
	record: RuntimeLogLine,
	options: LlmLogFormatOptions = {},
): string {
	const cfg: Required<LlmLogFormatOptions> = {
		...DEFAULTS,
		...options,
		maxChars: clampInt(options.maxChars, DEFAULTS.maxChars, 200, 200_000),
		maxLineChars: clampInt(options.maxLineChars, DEFAULTS.maxLineChars, 80, 4_000),
		maxStackLines: clampInt(options.maxStackLines, DEFAULTS.maxStackLines, 1, 50),
	}

	const time = typeof record.ts === 'number' ? toIsoTime(record.ts) : 'time?'
	const level = typeof record.level === 'string' ? record.level : 'info'

	const pieces: string[] = [time, level.toUpperCase()]

	if (cfg.includeCategory && Array.isArray(record.category) && record.category.length > 0) {
		pieces.push(record.category.join('.'))
	}

	if (cfg.includeOrigin) {
		const origin = record.pluginId ?? record.context ?? record.name
		if (origin) pieces.push(origin)
	}

	const head = `[${pieces.join('] [')}]`
	const body = formatMessageParts(record, Math.max(40, cfg.maxLineChars - head.length - 2))

	let line = `${head} ${body}`.trim()

	if (cfg.includeProps) {
		const extra = formatSelectedProps(record, cfg.maxStackLines)
		if (extra) line = `${line}\n${extra}`
	}

	// Ensure a hard cap per line block (includes possible \n from error formatting).
	// Keep the first line readable; truncate the whole block for determinism.
	return truncate(line, cfg.maxLineChars)
}

export function formatUiLogRecordsForLlm(
	records: readonly RuntimeLogLine[],
	options: LlmLogFormatOptions = {},
): LlmLogsText {
	const cfg: Required<LlmLogFormatOptions> = {
		...DEFAULTS,
		...options,
		maxChars: clampInt(options.maxChars, DEFAULTS.maxChars, 200, 200_000),
		maxLineChars: clampInt(options.maxLineChars, DEFAULTS.maxLineChars, 80, 4_000),
		maxStackLines: clampInt(options.maxStackLines, DEFAULTS.maxStackLines, 1, 50),
	}

	const lines: string[] = []
	let used = 0
	let truncated = false

	// Collapse adjacent identical lines to reduce noise.
	let prev: string | null = null
	let prevCount = 0
	const pushPrev = () => {
		if (!prev) return
		const suffix = prevCount > 1 ? ` (x${prevCount})` : ''
		const line = `${prev}${suffix}`
		const add = line.length + (lines.length > 0 ? 1 : 0)
		if (used + add > cfg.maxChars) {
			truncated = true
			return
		}
		lines.push(line)
		used += add
	}

	for (let i = 0; i < records.length; i++) {
		const r = records[i]!
		const rendered = formatUiLogRecordForLlm(r, cfg)
		if (prev === null) {
			prev = rendered
			prevCount = 1
			continue
		}
		if (rendered === prev) {
			prevCount++
			continue
		}

		pushPrev()
		if (truncated) break
		prev = rendered
		prevCount = 1
	}

	if (!truncated) pushPrev()

	if (truncated) {
		const marker = '… (truncated)'
		if (used + (lines.length > 0 ? 1 : 0) + marker.length <= cfg.maxChars) {
			lines.push(marker)
		}
	}

	return { text: lines.join('\n'), count: lines.length, truncated }
}
