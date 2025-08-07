// src/logger.ts
import pino, { type Logger, type LoggerOptions } from 'pino'
import { multistream } from 'pino'
import pinoCaller from 'pino-caller'
import fs from 'node:fs'
import path from 'node:path'
import { Writable } from 'node:stream'
import EventEmitter from 'node:events'

/** 单条日志记录类型 */
export interface LogRecord {
	time: string
	level: number | string
	name?: string
	msg: string
	[key: string]: any
}

// 环形缓冲与事件发射
const ringSize = 500
const ring: LogRecord[] = new Array(ringSize)
let ptr = 0
const events = new EventEmitter()

function pushRecord(rec: LogRecord) {
	ring[ptr] = rec
	ptr = (ptr + 1) % ringSize
	events.emit('new_log', rec)
}

/** 获取从最旧到最新的完整日志快照 */
export function getOrderedLogs(): LogRecord[] {
	return [...ring.slice(ptr), ...ring.slice(0, ptr)].filter(Boolean)
}

// 日志持久化目录 & 写流
const logDir = path.resolve(process.cwd(), 'logs')
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir)
const fileStream = fs.createWriteStream(path.join(logDir, 'all.log'), {
	flags: 'a',
})

// 自定义 Writable，用于解析 JSON 并推送到环缓，同时写入文件
const jsonStream = new Writable({
	write(chunk, encoding, callback) {
		const str = chunk.toString()
		try {
			const obj = JSON.parse(str)
			pushRecord({
				time: obj.time || new Date().toISOString(),
				level: obj.level,
				name: obj.name,
				msg: obj.msg,
				...obj,
			})
		} catch {
			// 非 JSON 跳过
		}
		fileStream.write(str)
		callback()
	},
})

/** 创建 Pino Logger，多目标：文件(JSON)、stdout(Pretty)、环缓+事件 */
export function createLogger(opts: LoggerOptions): Logger {
	const isDev =
		process.env.NODE_ENV === 'development' || process.env.NODE_ENV === undefined

	const streams: Parameters<typeof multistream>[0] = [
		{ level: opts.level ?? 'info', stream: jsonStream },
		isDev && {
			level: opts.level ?? 'info',
			stream: pino.transport({
				target: 'pino-pretty',
				options: { colorize: true, ignore: 'pid,hostname' },
			}),
		},
	].filter(Boolean) as any

	const logger = pino(opts, multistream(streams))
	return isDev ? pinoCaller(logger) : logger
}

export { events }
