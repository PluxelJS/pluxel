/* ───────────────────────── Pretty Printer (fast, generic) ─────────────────────────
 * 设计要点（性能优先）：
 * - createPrettyPrinter(options) 预构建缓存，避免每行重复判定/分配
 * - 颜色与 Intl.DateTimeFormat 缓存一次；可自定义时间格式器（极致性能）
 * - extras 采用 key=value 紧凑样式；对象/数组智能摘要；重要键优先展示
 * - HTTP/通用“动作摘要”自动组合：METHOD URL/route -> CODE DURATION (IP)
 * - pino 兼容：time(epoch)、level(10-60/字符串)、name/logger/module/ns、err/stack
 * - SSE 兼容：pretty.formatLine("data: {...}")
 * ------------------------------------------------------------------------------- */

type AnyRec = Record<string, unknown>
type Level = 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL' | string

export interface PrettyOptions {
	/** Asia/Tokyo 等；留空走本地 */
	timeZone?: string
	/** 是否包含日期部分；默认 true */
	withDate?: boolean
	/** 是否包含毫秒；默认 true */
	withMillis?: boolean
	/** 是否显示级别图标；默认 false */
	withIcons?: boolean
	/** 附加字段样式：'kv' | 'hidden'；默认 'kv'（最快） */
	extrasStyle?: 'kv' | 'hidden'
	/** 每行附加字段最大字符；默认 160（0=不限） */
	extrasMaxLen?: number
	/** 名称最大长度（方括号段）；默认 40（0=不截断） */
	nameMax?: number
	/** 额外忽略键（在默认忽略集之外） */
	ignoreKeys?: string[]
	/** 强制彩色（覆盖自动判断） */
	forceColor?: boolean
	/** 自定义时间格式器：提供极致性能/自定义格式 */
	timeFormatter?: (d: Date) => string
}

export interface PrettyPrinter {
	/** 传对象（pino JSON）得到一行字符串 */
	format(obj: AnyRec): string
	/** 传原始行（SSE/fetch），自动去掉 data: 并 JSON 解析后 format */
	formatLine(line: string): string
}

/* ─── ANSI ─── */
const ANSI = {
	reset: '\x1b[0m',
	dim: '\x1b[2m',
	colors: {
		TRACE: '\x1b[90m',
		DEBUG: '\x1b[36m',
		INFO: '\x1b[32m',
		WARN: '\x1b[33m',
		ERROR: '\x1b[31m',
		FATAL: '\x1b[35m',
	} as Record<string, string>,
} as const

/* ─── 快速工具 ─── */
const hasProcess = typeof process !== 'undefined' && !!(process as any)
const stdoutTTY = hasProcess && (process as any).stdout && (process as any).stdout.isTTY
const env = hasProcess ? ((process as any).env ?? {}) : {}
const NO_COLOR = 'NO_COLOR' in env
const FORCE = 'FORCE_COLOR' in env

const LEVEL_NUM: Record<number, Level> = {
	10: 'TRACE',
	20: 'DEBUG',
	30: 'INFO',
	40: 'WARN',
	50: 'ERROR',
	60: 'FATAL',
}
const LEVEL_ICON: Record<string, string> = {
	TRACE: '…',
	DEBUG: '🐞',
	INFO: 'ℹ',
	WARN: '⚠',
	ERROR: '⛔',
	FATAL: '💥',
}

function toDate(t: unknown): Date {
	if (t == null) return new Date()
	if (t instanceof Date) return t
	const tp = typeof t
	if (tp === 'number') return new Date(t as number)
	if (tp === 'string') {
		const s = t as string
		// 纯数字（epoch ms）
		if (s.length && s.charCodeAt(0) >= 48 && /^\d+$/.test(s)) return new Date(Number(s))
		const d = new Date(s)
		if (!isNaN(d.getTime())) return d
	}
	return new Date()
}
function ucase(s: unknown): string {
	return String(s).toUpperCase()
}
function padEnd5(s: string): string {
	// 级别对齐：最少 5 列；未知级别也能对齐
	const need = 5 - s.length
	return need > 0 ? s + ' '.repeat(need) : s
}
function clamp(str: string, max: number): string {
	return max <= 0 || str.length <= max ? str : str.slice(0, Math.max(1, max - 1)) + '…'
}
function colorize(s: string, code: string, on: boolean) {
	return on ? code + s + ANSI.reset : s
}
function dim(s: string, on: boolean) {
	return on ? ANSI.dim + s + ANSI.reset : s
}

/* 重要键优先权重（越小越靠前） */
const KEY_WEIGHT: Record<string, number> = {
	method: 1,
	httpMethod: 1,
	verb: 1,
	url: 2,
	path: 2,
	route: 2,
	originalUrl: 2,
	status: 3,
	statusCode: 3,
	code: 3,
	duration: 4,
	responseTime: 4,
	latency: 4,
	ms: 4,
	rt: 4,
	took: 4,
	ip: 5,
	remoteAddress: 5,
	clientIp: 5,
	requestId: 6,
	traceId: 6,
	spanId: 6,
	correlationId: 6,
	rid: 6,
	userId: 7,
	uid: 7,
	sessionId: 7,
	sid: 7,
	id: 7,
	// 其他常见元键靠后
}

/* 智能摘要：不要求 req/res，见到 method+url/path、status/duration 就组合 */
function summarizeAction(o: AnyRec): string | undefined {
	// 直接字段
	const m = (o.method ?? (o as any).httpMethod ?? (o as any).verb) as unknown as string | undefined
	const u = (o.url ?? (o as any).originalUrl ?? (o as any).path ?? (o as any).route) as unknown as
		| string
		| undefined
	const sc = (o.statusCode ?? o.status ?? o.code) as unknown as number | string | undefined
	const dur = (o.responseTime ??
		o.duration ??
		(o as any).latency ??
		(o as any).ms ??
		(o as any).rt ??
		(o as any).took) as unknown as number | string | undefined
	const ip = (o.ip ?? (o as any).remoteAddress ?? (o as any).clientIp) as unknown as
		| string
		| undefined

	let ok = false
	const parts: string[] = []
	if (m || u) {
		parts.push(`${m ?? '—'} ${u ?? '—'}`)
		ok = true
	}
	const tail: string[] = []
	if (sc != null && sc !== '') tail.push(String(sc))
	if (dur != null && dur !== '') tail.push(`${dur}ms`)
	if (tail.length) {
		parts.push('-> ' + tail.join(' '))
		ok = true
	}
	if (ip) parts.push(`(${ip})`)
	return ok ? parts.join(' ') : undefined
}

/* 将任意值压成单行、适合 kv 的 value（快速&可控） */
function foldValue(v: unknown, maxLen: number): string {
	const t = typeof v
	if (v == null || t === 'number' || t === 'boolean') return String(v)
	if (t === 'string') {
		let s = v as string
		if (maxLen > 0 && s.length > maxLen) s = s.slice(0, maxLen - 1) + '…'
		// 无空白与特殊字符时直接裸输出，否则 JSON.stringify 以便转义
		return /^[^\s"\\]+$/.test(s) ? s : JSON.stringify(s)
	}
	// object/array/function/symbol：用 JSON（最快的安全法），失败则标签化
	try {
		const s = JSON.stringify(v)
		if (!s) return String(v)
		if (maxLen > 0 && s.length > maxLen) return s.slice(0, maxLen - 1) + '…'
		return s
	} catch {
		const tag = Object.prototype.toString.call(v) // [object X]
		return tag.slice(8, -1)
	}
}

/* 日期格式器缓存（按选项 key） */
const dtfCache = new Map<string, Intl.DateTimeFormat>()
function getDtf(tz?: string, withMillis = true, withDate = true): Intl.DateTimeFormat {
	const key = (tz ?? 'local') + '|' + (withMillis ? 'ms' : 's') + '|' + (withDate ? 'd' : 't')
	let f = dtfCache.get(key)
	if (!f) {
		const options: Intl.DateTimeFormatOptions = {
			timeZone: tz,
			hour12: false,
			year: withDate ? 'numeric' : undefined,
			month: withDate ? '2-digit' : undefined,
			day: withDate ? '2-digit' : undefined,
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
		}
		if (withMillis) options.fractionalSecondDigits = 3
		f = new Intl.DateTimeFormat(undefined, options)
		dtfCache.set(key, f)
	}
	return f
}

/* 级别解析（数字/字符串） */
function normLevel(l: unknown): Level {
	if (typeof l === 'number') return LEVEL_NUM[l] ?? String(l)
	const s = ucase(l)
	return s === 'WARNING' ? 'WARN' : s
}

/* 工厂：构建一个高性能 PrettyPrinter */
export function createPrettyPrinter(opts: PrettyOptions = {}): PrettyPrinter {
	const {
		timeZone,
		withDate = true,
		withMillis = true,
		withIcons = false,
		extrasStyle = 'kv',
		nameMax = 40,
		extrasMaxLen = 160,
		ignoreKeys = [],
		forceColor,
		timeFormatter,
	} = opts

	// 颜色开关一次判定
	const useColor =
		typeof forceColor === 'boolean' ? forceColor : FORCE || (!NO_COLOR && !!stdoutTTY)

	// 预生成时间格式函数
	const fmtTime = timeFormatter
		? timeFormatter
		: (d: Date) => getDtf(timeZone, withMillis, withDate).format(d)

	// 默认忽略（pino 元信息）
	const ignore = new Set<string>([
		'pid',
		'hostname',
		'v',
		'time',
		'level',
		'name',
		'pluginId',
		'msg',
		'logger',
		'module',
		'ns',
		'context',
	])
	for (let i = 0; i < ignoreKeys.length; i++) ignore.add(ignoreKeys[i])

	// 预计算键排序：按 KEY_WEIGHT + 字典序
	const weight = (k: string): number => KEY_WEIGHT[k] ?? 1000

	function format(obj: AnyRec): string {
		// —— 解析基础字段（避免解构，减少隐式枚举器创建）——
		const lv = normLevel(obj.level)
		const levelPadded = padEnd5(typeof lv === 'string' ? lv : String(lv))
		const lvCol = ANSI.colors[lv] || '' // 未知级别则不着色
		const timeStr = fmtTime(toDate(obj.time))

		let name = obj.name as string | undefined
		if (!name) name = (obj as any).logger as string | undefined
		if (!name) name = (obj as any).module as string | undefined
		if (!name) name = (obj as any).ns as string | undefined
		if (!name) name = (obj as any).context as string | undefined
		const nameSeg = name ? ' [' + clamp(String(name), nameMax) + ']' : ''

		// msg：优先字符串，否则 JSON 压缩
		let msg = ''
		const rawMsg = (obj as any).msg
		if (typeof rawMsg === 'string') {
			msg = rawMsg
		} else if (rawMsg != null) {
			try {
				msg = JSON.stringify(rawMsg)
			} catch {
				msg = String(rawMsg)
			}
		}

		// 错误/栈
		const err = (obj as any).err ?? (obj as any).error
		const stack = (err && (err as any).stack) || (obj as any).stack
		const hasStack = typeof stack === 'string' && stack.length > 0

		// 通用动作摘要（HTTP/自定义字段都可拼）
		const action = summarizeAction(obj)

		// 附加字段（kv 紧凑）
		let extras = ''
		if (extrasStyle !== 'hidden') {
			// 收集其余未忽略键
			// 为稳定 & 高可读性：按权重 + 字典序
			const keys: string[] = []
			for (const k in obj)
				if (!ignore.has(k) && k !== 'err' && k !== 'error' && k !== 'stack') keys.push(k)
			if (keys.length) {
				keys.sort((a, b) => {
					const wa = weight(a),
						wb = weight(b)
					return wa === wb ? (a < b ? -1 : a > b ? 1 : 0) : wa - wb
				})
				// 生成 k=v 片段（避免频繁数组 join：直接拼字符串更快）
				let out = ''
				for (let i = 0; i < keys.length; i++) {
					const k = keys[i]
					const v = (obj as any)[k]
					if (v === undefined) continue
					const val = foldValue(v, extrasMaxLen > 0 ? extrasMaxLen : 0)
					// 以空格分隔，键含不合法字符时仍然安全（值已处理）
					out += (i === 0 ? '' : ' ') + k + '=' + val
				}
				if (out) extras = ' ' + dim(out, useColor)
			}
		}

		// 组装（尽量少的字符串拼接次数）
		const pieces: string[] = []
		pieces.push(dim(timeStr, useColor))
		pieces.push(colorize(levelPadded, lvCol, useColor))
		if (withIcons) pieces.push(LEVEL_ICON[lv] || '')
		if (nameSeg) pieces.push(nameSeg)
		if (msg) pieces.push(msg.startsWith(' ') ? msg : ' ' + msg)
		if (action) pieces.push(' ' + action)
		if (extras) pieces.push(extras)

		let line = pieces
			.join(' ')
			// 上面为了减少判断，可能插入了多余空格；做一次轻量规范化
			.replace(/\s{2,}/g, ' ')
			.trim()

		if (hasStack) line += '\n' + dim(String(stack), useColor)
		return line
	}

	function formatLine(line: string): string {
		const hasData = line.startsWith('data:')
		const text = hasData ? line.slice(5).trimStart() : line
		try {
			const obj = JSON.parse(text) as AnyRec
			return format(obj)
		} catch {
			return text
		}
	}

	return { format, formatLine }
}

/* ─── 用法示例 ───
const pretty = createPrettyPrinter({
  timeZone: 'Asia/Tokyo',
  withDate: true,
  withMillis: true,
  withIcons: true,
  extrasStyle: 'kv',
  extrasMaxLen: 120,
  nameMax: 24,
})

// pino: logger.info({ userId: 42, method: 'GET', url: '/u/42', statusCode: 200, responseTime: 8 }, 'OK')
pretty.formatLine('data: {"time":1723861425123,"level":30,"name":"api","msg":"OK","userId":42,"method":"GET","url":"/u/42","statusCode":200,"responseTime":8}')
// -> 2025-08-17 11:23:45.123 INFO  [api] OK GET /u/42 -> 200 8ms {"userId":42}
*/
