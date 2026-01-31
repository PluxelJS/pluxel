import type { LogRecord as UiLogRecord } from '@pluxel/hmr-web'

export type PrettyMode = 'global' | 'scoped'

export type PrettyOptions = {
	mode?: PrettyMode
	showCategory?: boolean
	showName?: boolean
	showProps?: 'auto' | boolean
}

export type PrettyPrinter = {
	format(record: UiLogRecord): string
}

const ANSI = {
	reset: '\u001B[0m',
	dim: '\u001B[2m',
	bold: '\u001B[1m',
	underline: '\u001B[4m',
	grey: '\u001B[90m',
	red: '\u001B[31m',
	green: '\u001B[32m',
	yellow: '\u001B[33m',
	blue: '\u001B[34m',
	magenta: '\u001B[35m',
	cyan: '\u001B[36m',
}

function color(code: string, text: string): string {
	return `${code}${text}${ANSI.reset}`
}

function pad2(n: number): string {
	return n < 10 ? `0${n}` : String(n)
}
function pad3(n: number): string {
	if (n < 10) return `00${n}`
	if (n < 100) return `0${n}`
	return String(n)
}

function formatTime(epochMs: number): string {
	const d = new Date(epochMs)
	return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${pad3(d.getMilliseconds())}`
}

function normalizeLevel(level: string): UiLogRecord['level'] {
	const l = level.toLowerCase()
	if (l === 'warn') return 'warning'
	return l
}

function levelColor(level: string): string {
	switch (normalizeLevel(level)) {
		case 'trace':
			return ANSI.grey
		case 'debug':
			return ANSI.blue
		case 'info':
			return ANSI.green
		case 'warning':
			return ANSI.yellow
		case 'error':
			return ANSI.red
		case 'fatal':
			return ANSI.magenta
		default:
			return ANSI.green
	}
}

function shouldShowProps(
	level: string,
	mode: PrettyMode,
	show: PrettyOptions['showProps'],
): boolean {
	if (show === true) return true
	if (show === false) return false
	if (mode === 'scoped') return false
	const l = normalizeLevel(level)
	return l === 'warning' || l === 'error' || l === 'fatal'
}

function formatPrimitive(v: unknown): string {
	if (typeof v === 'string') return v
	if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v)
	if (v === null) return 'null'
	if (v === undefined) return 'undefined'
	try {
		const s = JSON.stringify(v)
		// Keep the log viewer snappy even when props contain large structures.
		return s.length > 400 ? `${s.slice(0, 400)}…` : s
	} catch {
		return String(v)
	}
}

function formatPropsInline(props: Record<string, unknown>): string {
	const maxKeys = 4
	const entries: Array<[string, unknown]> = []
	let total = 0
	for (const k in props) {
		if (!Object.hasOwn(props, k)) continue
		const v = props[k]
		if (v === undefined) continue
		total++
		if (entries.length < maxKeys) entries.push([k, v])
	}
	if (!total) return ''

	// Keep output stable without sorting potentially-large props objects.
	entries.sort(([a], [b]) => a.localeCompare(b))

	const parts = entries.map(([k, v]) => {
		const key = color(ANSI.cyan, k)
		const val = color(ANSI.yellow, formatPrimitive(v))
		return `${key}${color(ANSI.grey, '=')}${val}`
	})
	const more = total > maxKeys ? color(ANSI.grey, ` …(+${total - maxKeys})`) : ''
	return `${color(ANSI.grey, '⟪')}${parts.join(color(ANSI.grey, ' '))}${more}${color(ANSI.grey, '⟫')}`
}

function stripNamePrefix(message: string, name?: string): string {
	if (!message || !name) return message
	const shortName = name.split('(')[0]?.trim()
	const candidates = [`[${name}]`, shortName ? `[${shortName}]` : ''].filter(Boolean)
	for (const c of candidates) {
		if (message.startsWith(c)) {
			return message.slice(c.length).trimStart()
		}
	}
	return message
}

function messageToText(record: UiLogRecord): string {
	// Prefer structured parts when present; fall back to legacy msg.
	const parts = record.message
	if (Array.isArray(parts) && parts.length) {
		const limit = 12000
		let out = ''

		const previewObject = (obj: object): string => {
			const rec = obj as Record<string, unknown>
			let total = 0
			let picked = 0
			let s = '{'
			for (const k in rec) {
				if (!Object.hasOwn(rec, k)) continue
				total++
				if (picked < 4) {
					const v = rec[k]
					if (picked) s += ', '
					s += `${k}=${formatPrimitive(v)}`
					picked++
				}
			}
			if (total > 4) s += ', …'
			s += '}'
			return s
		}

		const formatPart = (part: unknown): string => {
			if (typeof part === 'string') return part
			if (typeof part === 'number' || typeof part === 'boolean' || typeof part === 'bigint')
				return String(part)
			if (part === null || part === undefined) return String(part)
			if (typeof part === 'object') return previewObject(part as object)
			return String(part)
		}

		for (let i = 0; i < parts.length; i++) {
			out += formatPart(parts[i])
			if (out.length >= limit) {
				out = `${out.slice(0, limit)}…`
				break
			}
		}

		return out
	}
	return record.msg
}

export function createPrettyPrinter(options: PrettyOptions = {}): PrettyPrinter {
	const mode: PrettyMode = options.mode ?? 'global'
	const showCategory = options.showCategory ?? mode === 'global'
	const showName = options.showName ?? mode === 'global'
	const showProps = options.showProps ?? 'auto'

	const format = (record: UiLogRecord): string => {
		const time = color(ANSI.grey, formatTime(record.time))
		const lvl = normalizeLevel(record.level)
		const levelText = color(`${ANSI.bold}${levelColor(lvl)}`, lvl.padEnd(7))

		const categoryText =
			showCategory && record.category?.length ? color(ANSI.cyan, record.category.join('·')) : ''

		const nameText = showName && record.name ? color(ANSI.grey, `[${record.name}]`) : ''

		const msg = stripNamePrefix(
			messageToText(record).trim(),
			showName || mode === 'scoped' ? record.name : undefined,
		)
		const propsText =
			record.props && shouldShowProps(lvl, mode, showProps) ? formatPropsInline(record.props) : ''

		let out = `${time} ${levelText}`
		if (categoryText) out += ` ${categoryText}`
		if (nameText) out += ` ${nameText}`
		if (msg) out += ` ${msg}`
		if (propsText) out += ` ${propsText}`
		return out
	}

	return { format }
}
