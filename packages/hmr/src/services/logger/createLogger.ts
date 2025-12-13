// src/createLogger.ts

import fs from 'node:fs'
import path from 'node:path'
import { Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import pino, { type Logger, type LoggerOptions, multistream } from 'pino'
import pinoPretty from 'pino-pretty'
import * as rfs from 'rotating-file-stream'
/** ---------- Structured record + store ---------- */
import { type LogRecord, logStore } from './logStore'
import {
	attachPrettyErrors,
	type PrettyErrorPayload,
	type PrettyErrorSink,
	writePrettyErrorToStderr,
} from './prettyErrors'
import { createDumperLogHook, makeErrSerializer } from './serialization'

export type { LogRecord } from './logStore'

export const events = logStore.events
export const getOrderedLogs = (limit = logStore.capacity) => logStore.snapshot(limit)

/** ---------- Log dir + rotating file ---------- */
const LOG_DIR = path.resolve(process.cwd(), 'logs')
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true })

// 每次启动新文件 + 按天轮转，保留 7 天
const rotatingStream = rfs.createStream(
	() => `app-${new Date().toISOString().replace(/[:.]/g, '-')}.log`,
	{
		interval: '1d',
		path: LOG_DIR,
		maxFiles: 7,
	},
)

/** ---------- JSON stream: feed ring + file ---------- */
const jsonStream = new Writable({
	write(chunk, _enc, cb) {
		const line = chunk.toString()
		try {
			const obj = JSON.parse(line) as LogRecord
			if (!obj.time) obj.time = new Date().toISOString()
			if (obj.msg === undefined || obj.msg === null) obj.msg = ''
			if (obj.level === undefined || obj.level === null) obj.level = 'info'
			logStore.push(obj)
		} catch {
			// 非 JSON —— 忽略，但仍写文件
		}
		rotatingStream.write(line)
		cb()
	},
})

/** ---------- Pretty console ---------- */
const prettyStream = pinoPretty({
	colorize: true,
	ignore: 'pid,hostname',
	translateTime: 'SYS:standard',
})

/** ---------- Pretty error sinks ---------- */
function createPrettyErrorLoggerSink(root: Logger): PrettyErrorSink {
	const children = new Map<string, Logger>()
	const getTarget = (scope?: string) => {
		if (!scope) return root
		if (!children.has(scope)) {
			children.set(scope, root.child({ scope }))
		}
		return children.get(scope) ?? root
	}

	return (payload: PrettyErrorPayload) => {
		const target = getTarget(payload.scope)
		target.error(
			{
				err: payload.error,
				scope: payload.scope,
				prettyError: true,
				prettyPlain: payload.plain,
			},
			payload.error?.message ?? 'Pretty error',
		)
	}
}

const PRETTY_DUPLEX_ENABLED = (process.env.PLUXEL_LOGGER_PRETTY_DUPLEX ?? '0') !== '0'

type CallerOptions = {
	relativeTo?: string
	stackAdjustment?: number
}

const CALLER_SKIP_PATTERNS = [
	'/node_modules/pino/',
	'\\node_modules\\pino\\',
	'/node_modules/pino-pretty/',
	'\\node_modules\\pino-pretty\\',
]

function toPathIfFileUrl(fileName: string): string {
	if (fileName.startsWith('file://')) {
		try {
			return fileURLToPath(fileName)
		} catch {
			// fallthrough
		}
	}
	return fileName
}

function stripRelativeTo(fileName: string, relativeTo?: string): string {
	if (!relativeTo) return fileName
	const file = toPathIfFileUrl(fileName).replaceAll('\\', '/')
	const base = relativeTo.replaceAll('\\', '/')
	const baseWithSlash = base.endsWith('/') ? base : `${base}/`
	return file.startsWith(baseWithSlash) ? file.slice(baseWithSlash.length) : file
}

function shouldSkipFrame(fileName: string, loggerDir: string): boolean {
	const normalized = toPathIfFileUrl(fileName).replaceAll('\\', '/')
	// Skip Node.js built-in modules (e.g. node:diagnostics_channel)
	if (normalized.startsWith('node:')) return true
	if (normalized.startsWith('internal:')) return true
	if (normalized.startsWith(loggerDir)) return true
	for (const pattern of CALLER_SKIP_PATTERNS) {
		if (normalized.includes(pattern)) return true
	}
	return false
}

function getCaller(options: CallerOptions, loggerDir: string): string | undefined {
	const stackAdjustment = options.stackAdjustment ?? 0

	// Prefer structured CallSite stacks (faster + less brittle).
	const originalPrepare = Error.prepareStackTrace
	try {
		Error.prepareStackTrace = (_err, stack) => stack as unknown as string
		const err = new Error()
		Error.captureStackTrace(err, getCaller)
		const stack = err.stack as unknown as NodeJS.CallSite[] | undefined
		if (Array.isArray(stack)) {
			let picked: NodeJS.CallSite | undefined
			let seen = 0
			for (const callSite of stack) {
				const fileName = callSite.getFileName?.()
				if (!fileName) continue
				if (shouldSkipFrame(fileName, loggerDir)) continue
				if (seen < stackAdjustment) {
					seen++
					continue
				}
				picked = callSite
				break
			}

			if (!picked) return undefined
			const fileName = picked.getFileName?.()
			if (!fileName) return undefined
			const line = picked.getLineNumber?.() ?? 0
			const col = picked.getColumnNumber?.() ?? 0
			const fn =
				picked.getMethodName?.() ??
				picked.getFunctionName?.() ??
				picked.getTypeName?.() ??
				undefined

			const loc = `${stripRelativeTo(fileName, options.relativeTo)}:${line}:${col}`
			return fn ? `${fn} (${loc})` : loc
		}
	} catch {
		// fallthrough to string parsing
	} finally {
		Error.prepareStackTrace = originalPrepare
	}

	// Fallback: parse stack string (works in runtimes without CallSite support).
	try {
		const raw = String(new Error().stack ?? '')
		const lines = raw.split('\n').slice(1)
		const filtered = lines.filter((line) => {
			const l = line.trim()
			if (!l) return false
			// Skip Node.js built-in/internal frames (e.g. node:diagnostics_channel, node:internal/*)
			if (l.includes('node:')) return false
			if (l.includes('internal/')) return false
			if (l.includes('internal\\')) return false
			const normalized = l.replaceAll('\\', '/')
			if (normalized.includes(loggerDir)) return false
			for (const pattern of CALLER_SKIP_PATTERNS) {
				if (normalized.includes(pattern)) return false
			}
			return true
		})

		const picked = filtered[stackAdjustment]
		if (!picked) return undefined
		const withoutAt = picked.trim().replace(/^at\\s+/, '')
		const match = withoutAt.match(/\\((.*)\\)$/)
		if (match?.[1]) {
			const openParen = withoutAt.indexOf('(')
			const name = openParen > 0 ? withoutAt.slice(0, openParen).trim() : ''
			const loc = stripRelativeTo(match[1], options.relativeTo)
			return name ? `${name} (${loc})` : loc
		}
		return stripRelativeTo(withoutAt, options.relativeTo)
	} catch {
		return undefined
	}
}

/** ---------- Factory ---------- */
/**
 * 创建 Logger：
 * - 结构化日志 → jsonStream（写环缓与事件，同时落 rotating file）
 * - 控制台输出 → prettyStream
 * - Map/Set/BigInt/Date → Dumper hook 做 JSON-safe 展开 + fallback 描述
 * - Error → 自定义 err serializer（含 cause + 附加字段）
 * - ✅ Dumper hook 不再写只读的 args（修复 TS “readonly 参数” 报错）
 */
const versions = process?.versions as unknown as { bun?: string } | undefined
const isBun = !!versions?.bun
export function createLogger(opts: LoggerOptions): Logger {
	const level = opts.level ?? 'info'
	const streams = [
		{ level, stream: jsonStream },
		{ level, stream: prettyStream },
	]

	const hooks = {
		...(opts.hooks ?? {}),
		logMethod: createDumperLogHook({
			transformAllObjects: false,
		}),
	} as LoggerOptions['hooks']

	const loggerDir = path
		.dirname(fileURLToPath(import.meta.url))
		.replaceAll('\\', '/')
		.concat('/')
	const callerOptions: CallerOptions = {
		relativeTo: process.cwd(),
		stackAdjustment: isBun ? 0 : 1,
	}

	const baseFormatters = opts.formatters
	const baseLogFormatter = baseFormatters?.log
	const formatters: LoggerOptions['formatters'] = {
		...baseFormatters,
		log(obj) {
			const out = (baseLogFormatter ? baseLogFormatter(obj) : obj) as Record<string, unknown>
			if (out && typeof out === 'object' && out.caller === undefined) {
				const caller = getCaller(callerOptions, loggerDir)
				if (caller) out.caller = caller
			}
			return out
		},
	}

	const config = {
		...opts,
		serializers: { err: makeErrSerializer(), ...opts.serializers },
		hooks,
		formatters,
	} as LoggerOptions

	const base = pino(config, multistream(streams))

	const prettyErrorRoot = base.child({ channel: 'pretty-error' })
	const sinks: PrettyErrorSink[] = [writePrettyErrorToStderr]
	if (PRETTY_DUPLEX_ENABLED) {
		sinks.push(createPrettyErrorLoggerSink(prettyErrorRoot))
	}

	const prettyOptions: { scope?: string; sinks: PrettyErrorSink[] } = { sinks }
	if (typeof opts.name === 'string' && opts.name.length > 0) {
		prettyOptions.scope = opts.name
	}
	return attachPrettyErrors(base, prettyOptions)
}

export type { Logger }
