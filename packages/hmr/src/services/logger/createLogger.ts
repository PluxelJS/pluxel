// src/createLogger.ts
import fs from 'node:fs'
import path from 'node:path'
import { Writable } from 'node:stream'
import EventEmitter from 'node:events'
import * as rfs from 'rotating-file-stream'
import pino, { multistream, type Logger, type LoggerOptions } from 'pino'
import pinoCaller from 'pino-caller'
import pinoPretty from 'pino-pretty'

// —— 结构化日志记录类型 ——
export interface LogRecord {
	time: string
	level: number | string
	name?: string
	msg: string
	[key: string]: any
}

// —— 环形缓冲 & 事件 ——
const RING_SIZE = 500
const ring: Array<LogRecord | undefined> = new Array(RING_SIZE)
let ringPtr = 0
export const events = new EventEmitter()
events.setMaxListeners(1000)

function pushRecord(rec: LogRecord) {
	ring[ringPtr] = rec
	ringPtr = (ringPtr + 1) % RING_SIZE
	events.emit('new_log', rec)
}

/**
 * 获取历史结构化日志（最旧→最新），可选 limit
 */
export function getOrderedLogs(limit = RING_SIZE): LogRecord[] {
	const result: LogRecord[] = []
	const cnt = Math.min(limit, RING_SIZE)
	for (let i = 0; i < cnt; i++) {
		const idx = (ringPtr + i) % RING_SIZE
		const rec = ring[idx]
		if (rec) result.push(rec)
	}
	return result
}

// —— 日志目录 & 确保存在 ——
const LOG_DIR = path.resolve(process.cwd(), 'logs')
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true })

// —— 文件轮转：每次启动生成独立文件，并按天轮转，保留 7 天 ——
const rotatingStream = rfs.createStream(
	() => `app-${new Date().toISOString().replace(/[:.]/g, '-')}.log`,
	{
		interval: '1d',
		path: LOG_DIR,
		maxFiles: 7,
	},
)

// —— JSON 写流：拦截记录→环缓→文件 ——
const jsonStream = new Writable({
	write(chunk, _enc, cb) {
		const line = chunk.toString()
		try {
			const obj = JSON.parse(line) as LogRecord
			pushRecord({
				time: obj.time || new Date().toISOString(),
				level: obj.level,
				name: obj.name,
				msg: obj.msg,
				...obj,
			})
		} catch {
			// 非 JSON，忽略
		}
		rotatingStream.write(line)
		cb()
	},
})

// —— 控制台 Pretty 输出 ——
const prettyStream = pinoPretty({
	colorize: true,
	ignore: 'pid,hostname',
	translateTime: 'SYS:standard',
})

/**
 * 创建 Logger：
 * - 结构化日志 → jsonStream → 文件轮转 & 环缓 + 事件
 * - 控制台输出 → prettyStream
 */
export function createLogger(opts: LoggerOptions): Logger {
	const level = opts.level ?? 'info'
	const streams = [
		{ level, stream: jsonStream },
		{ level, stream: prettyStream },
	]
	const base = pino(opts, multistream(streams))
	return pinoCaller(base)
}

export type { Logger }
