// src/createLogger.ts

import fs from 'node:fs'
import path from 'node:path'
import { Writable } from 'node:stream'
import pino, { type Logger, type LoggerOptions, multistream } from 'pino'
import pinoCaller from 'pino-caller'
import pinoPretty from 'pino-pretty'
import * as rfs from 'rotating-file-stream'
import {
	attachPrettyErrors,
	type PrettyErrorPayload,
	type PrettyErrorSink,
	writePrettyErrorToStderr,
} from './prettyErrors'
import { createDumperLogHook, makeErrSerializer } from './serialization'

/** ---------- Structured record + store ---------- */
import { logStore, type LogRecord } from './logStore'
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
			logStore.push({
				time: obj.time || new Date().toISOString(),
				level: obj.level,
				name: obj.name,
				msg: obj.msg,
				...obj,
			})
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

/** ---------- Factory ---------- */
/**
 * 创建 Logger：
 * - 结构化日志 → jsonStream（写环缓与事件，同时落 rotating file）
 * - 控制台输出 → prettyStream
 * - Map/Set/BigInt/Date → Dumper hook 做 JSON-safe 展开 + fallback 描述
 * - Error → 自定义 err serializer（含 cause + 附加字段）
 * - ✅ Dumper hook 不再写只读的 args（修复 TS “readonly 参数” 报错）
 */
const isBun = !!(process?.versions as any)?.bun
export function createLogger(opts: LoggerOptions): Logger {
	const level = opts.level ?? 'info'
	const streams = [
		{ level, stream: jsonStream },
		{ level, stream: prettyStream },
	]

	const base = pino(
		{
			...opts,
			serializers: { err: makeErrSerializer(), ...opts.serializers },
			hooks: {
				logMethod: createDumperLogHook({
					transformAllObjects: false,
				}),
				...opts.hooks,
			},
		},
		multistream(streams),
	)

	const prettyErrorRoot = base.child({ channel: 'pretty-error' })
	const sinks: PrettyErrorSink[] = [writePrettyErrorToStderr]
	if (PRETTY_DUPLEX_ENABLED) {
		sinks.push(createPrettyErrorLoggerSink(prettyErrorRoot))
	}

	// 可选：保留 caller 信息（文件/行号）
	const withCaller = pinoCaller(base, {
		relativeTo: process.cwd(),
		stackAdjustment: isBun ? 0 : 1,
	})

	return attachPrettyErrors(withCaller, {
		scope: opts.name as string | undefined,
		sinks,
	})
}

export type { Logger }
