import type { ReactNode } from 'react'
import type { RuntimeLogLine } from '../../runtime'
import { stringifyUnknown } from '../../utils/unknown'

const ANSI_ESC = '\u001b'
const ANSI_CSI_RE = new RegExp(`${ANSI_ESC}\\[[0-9;]*[A-Za-z]`, 'g')
// OSC sequences terminate with BEL or ESC followed by a backslash; matching controls is intentional.
// oxlint-disable-next-line no-control-regex
const ANSI_OSC_RE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g
const ANSI_SGR_RE = new RegExp(`${ANSI_ESC}\\[([0-9;]*)m`, 'g')

function pad2(n: number): string {
	return n < 10 ? `0${n}` : String(n)
}
function pad3(n: number): string {
	if (n < 10) return `00${n}`
	if (n < 100) return `0${n}`
	return String(n)
}

export function formatTime(epochMs: number): string {
	const d = new Date(epochMs)
	return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${pad3(d.getMilliseconds())}`
}

export function formatCategory(category?: string[]): string {
	if (!Array.isArray(category) || category.length === 0) return ''
	return category.join('·')
}

export function oneLine(s: string): string {
	if (!s) return ''
	return s.replaceAll(/\r\n|\r|\n/g, '⏎').replaceAll('	', '⇥')
}

function xterm256(n: number, ansi16: readonly string[]): string | undefined {
	if (!Number.isFinite(n) || n < 0 || n > 255) return undefined
	if (n < 16) return ansi16[n]
	if (n >= 232) {
		const v = 8 + (n - 232) * 10
		return `rgb(${v},${v},${v})`
	}
	const idx = n - 16
	const r = Math.floor(idx / 36)
	const g = Math.floor((idx % 36) / 6)
	const b = idx % 6
	const cv = (x: number) => (x === 0 ? 0 : 55 + x * 40)
	return `rgb(${cv(r)},${cv(g)},${cv(b)})`
}

export function stripAnsi(s: string): string {
	if (!s) return ''
	// Best-effort: strip CSI sequences (incl. SGR) and OSC hyperlinks.
	return s.replace(ANSI_CSI_RE, '').replace(ANSI_OSC_RE, '')
}

type AnsiStyle = {
	color?: string
	backgroundColor?: string
	fontWeight?: number
	fontStyle?: 'italic'
	textDecoration?: string
}

export function renderAnsi(text: string, ansi16: readonly string[]): ReactNode {
	if (!text || !text.includes('\u001b[')) return stripAnsi(text)

	const parts: Array<{ key: string; text: string; style: AnsiStyle | null }> = []
	let style: AnsiStyle = {}

	const push = (chunk: string, start: number, end: number) => {
		chunk = stripAnsi(chunk)
		if (!chunk) return
		const st = Object.keys(style).length > 0 ? { ...style } : null
		parts.push({ key: `${start}:${end}`, text: chunk, style: st })
	}

	const sgr = new RegExp(ANSI_SGR_RE)
	let last = 0
	for (;;) {
		const m = sgr.exec(text)
		if (!m) break
		const idx = m.index
		push(text.slice(last, idx), last, idx)
		last = idx + m[0].length

		const raw = m[1] ?? ''
		const codes = raw ? raw.split(';') : ['0']
		const nums = codes.map((c) => (c ? Number(c) : 0)).filter((n) => Number.isFinite(n)) as number[]
		if (nums.length === 0) nums.push(0)

		for (let i = 0; i < nums.length; i++) {
			const code = nums[i]!
			if (code === 0) {
				style = {}
				continue
			}
			if (code === 1) {
				style.fontWeight = 700
				continue
			}
			if (code === 22) {
				delete style.fontWeight
				continue
			}
			if (code === 3) {
				style.fontStyle = 'italic'
				continue
			}
			if (code === 23) {
				delete style.fontStyle
				continue
			}
			if (code === 4) {
				style.textDecoration = 'underline'
				continue
			}
			if (code === 24) {
				delete style.textDecoration
				continue
			}

			// 16-color
			if (code >= 30 && code <= 37) {
				style.color = ansi16[code - 30]!
				continue
			}
			if (code >= 90 && code <= 97) {
				style.color = ansi16[8 + (code - 90)]!
				continue
			}
			if (code === 39) {
				delete style.color
				continue
			}

			if (code >= 40 && code <= 47) {
				style.backgroundColor = ansi16[code - 40]!
				continue
			}
			if (code >= 100 && code <= 107) {
				style.backgroundColor = ansi16[8 + (code - 100)]!
				continue
			}
			if (code === 49) {
				delete style.backgroundColor
				continue
			}

			// Extended colors: 38/48;5;n or 38/48;2;r;g;b
			if (code === 38 || code === 48) {
				const isBg = code === 48
				const mode = nums[i + 1]
				if (mode === 5) {
					const n = nums[i + 2]
					const c = typeof n === 'number' ? xterm256(n, ansi16) : undefined
					if (c) {
						if (isBg) style.backgroundColor = c
						else style.color = c
					}
					i += 2
					continue
				}
				if (mode === 2) {
					const r = nums[i + 2]
					const g = nums[i + 3]
					const b = nums[i + 4]
					if (
						typeof r === 'number' &&
						typeof g === 'number' &&
						typeof b === 'number' &&
						r >= 0 &&
						r <= 255 &&
						g >= 0 &&
						g <= 255 &&
						b >= 0 &&
						b <= 255
					) {
						const c = `rgb(${r},${g},${b})`
						if (isBg) style.backgroundColor = c
						else style.color = c
					}
					i += 4
				}
			}
		}
	}
	push(text.slice(last), last, text.length)

	if (parts.length === 0) return ''
	let hasStyle = false
	for (let i = 0; i < parts.length; i++) {
		if (parts[i]!.style) {
			hasStyle = true
			break
		}
	}
	if (!hasStyle) return parts.map((p) => p.text).join('')

	return parts.map((p) =>
		p.style ? (
			<span key={p.key} style={p.style}>
				{p.text}
			</span>
		) : (
			<span key={p.key}>{p.text}</span>
		),
	)
}

export function formatLineForCopy(
	line: RuntimeLogLine,
	opts: { showCategory: boolean; showName: boolean },
): string {
	const time = formatTime(line.ts)
	const level = String(line.level).toUpperCase()
	const category = opts.showCategory ? formatCategory(line.category) : ''
	const name = opts.showName && line.name ? `[${line.name}]` : ''
	const msg = stripAnsi(oneLine(messageToText(line)))
	return `${time} ${level}${category ? ` ${category}` : ''}${name ? ` ${name}` : ''} ${msg}`.trim()
}

export function messageToText(record: RuntimeLogLine): string {
	if (record.msg) return record.msg
	const parts = record.message
	if (!Array.isArray(parts) || parts.length === 0) return ''

	const limit = 12_000
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
				s += `${k}=${typeof v === 'string' ? v : serializeLogValue(v)}`
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
		if (part === null) return 'null'
		if (part === undefined) return 'undefined'
		if (typeof part === 'object') return previewObject(part as object)
		return stringifyUnknown(part)
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

/** Structured payloads remain inspectable even when a producer supplies non-JSON values. */
export function serializeLogValue(value: unknown): string {
	const seen = new WeakSet<object>()
	return (
		JSON.stringify(
			value,
			(_key, item: unknown) => {
				if (typeof item === 'bigint') return item.toString()
				if (item && typeof item === 'object') {
					if (seen.has(item)) return '[Circular]'
					seen.add(item)
					if (item instanceof Error)
						return { name: item.name, message: item.message, stack: item.stack }
				}
				return item
			},
			2,
		) ?? String(value)
	)
}
