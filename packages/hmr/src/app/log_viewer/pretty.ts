/** ANSI 颜色码映射，仅为前缀上色，提高可读性 */
const COLORS: Record<string, string> = {
	TRACE: '\x1b[90m',
	DEBUG: '\x1b[36m',
	INFO: '\x1b[32m',
	WARN: '\x1b[33m',
	ERROR: '\x1b[31m',
	FATAL: '\x1b[35m',
}
const RESET = '\x1b[0m'

/** 将数字或字符串等级转成大写标签 */
function getLevelLabel(level: number | string): string {
	const lvl = typeof level === 'number' ? level : level.toUpperCase()
	switch (lvl) {
		case 10:
		case '10':
			return 'TRACE'
		case 20:
		case '20':
			return 'DEBUG'
		case 30:
		case '30':
			return 'INFO'
		case 40:
		case '40':
			return 'WARN'
		case 50:
		case '50':
			return 'ERROR'
		case 60:
		case '60':
			return 'FATAL'
		default:
			return String(level).toUpperCase()
	}
}

/** 将单条日志对象格式化成 ANSI 彩色的前缀 + 普通文本 */
export function simplePretty(obj: {
	time?: string
	level: number | string
	name?: string
	msg?: string
}): string {
	const time = obj.time ?? new Date().toISOString()
	const lvl = getLevelLabel(obj.level)
	const col = COLORS[lvl] || ''
	// 彩色前缀包含时间和级别
	const prefix = `${time} ${lvl}`
	const coloredPrefix = `${col}${prefix}${RESET}`
	const nameSegment = obj.name ? `[${obj.name}] ` : ''
	const message = obj.msg ?? ''
	return `${coloredPrefix} ${nameSegment}${message}`
}

/** 处理 SSE 或 fetch 返回的“data:”前缀并尝试 JSON 解析 */
export function prettyLine(line: string): string {
	const text = line.startsWith('data:') ? line.replace(/^data:\s*/, '') : line
	try {
		const obj = JSON.parse(text)
		return simplePretty(obj)
	} catch {
		return text
	}
}
