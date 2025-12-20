import fs from 'node:fs'
import path from 'node:path'
import { Writable } from 'node:stream'
import type { DestinationStream } from 'pino'
import pinoPretty from 'pino-pretty'
import * as rfs from 'rotating-file-stream'

import { type LogRecord, logStore } from './logStore'

type PinoStream = { level: string; stream: DestinationStream }

const DEFAULT_LOG_DIR = path.resolve(process.cwd(), 'logs')
const RETENTION_DAYS = 7

const STORE_ENABLED = (process.env.PLUXEL_LOGGER_STORE ?? '1') !== '0'
const STORE_MIN_LEVEL = (process.env.PLUXEL_LOGGER_STORE_MIN_LEVEL ?? 'trace').toLowerCase()
const LEVEL_NUMBERS: Record<string, number> = {
	trace: 10,
	debug: 20,
	info: 30,
	warn: 40,
	error: 50,
	fatal: 60,
}
const STORE_MIN_LEVEL_NUMBER = LEVEL_NUMBERS[STORE_MIN_LEVEL] ?? LEVEL_NUMBERS.trace

let rotatingStream: NodeJS.WritableStream | undefined
let jsonStream: Writable | undefined
let prettyStream: DestinationStream | undefined

function ensureLogDir(dir: string) {
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function getRotatingStream(): NodeJS.WritableStream {
	if (rotatingStream) return rotatingStream
	ensureLogDir(DEFAULT_LOG_DIR)
	rotatingStream = rfs.createStream(
		() => `app-${new Date().toISOString().replace(/[:.]/g, '-')}.log`,
		{
			interval: '1d',
			path: DEFAULT_LOG_DIR,
			maxFiles: RETENTION_DAYS,
		},
	)
	return rotatingStream
}

function getJsonStream(): Writable {
	if (jsonStream) return jsonStream
	const file = getRotatingStream()
	jsonStream = new Writable({
		write(chunk, _enc, cb) {
			const line = chunk.toString()
			if (STORE_ENABLED) {
				let shouldStore = true
				if (STORE_MIN_LEVEL_NUMBER > LEVEL_NUMBERS.trace) {
					const idx = line.indexOf('"level":')
					if (idx !== -1) {
						let start = idx + 8
						while (line.charCodeAt(start) === 32) start++
						let end = start
						while (end < line.length) {
							const code = line.charCodeAt(end)
							if (code < 48 || code > 57) break
							end++
						}
						const levelValue = Number.parseInt(line.slice(start, end), 10)
						if (Number.isFinite(levelValue) && levelValue < STORE_MIN_LEVEL_NUMBER) {
							shouldStore = false
						}
					}
				}

				if (shouldStore) {
					try {
						const obj = JSON.parse(line) as LogRecord
						if (!obj.time) obj.time = new Date().toISOString()
						if (obj.msg === undefined || obj.msg === null) obj.msg = ''
						if (obj.level === undefined || obj.level === null) obj.level = 'info'
						logStore.push(obj)
					} catch {
						// 非 JSON —— 忽略，但仍写文件
					}
				}
			}
			file.write(line)
			cb()
		},
	})
	return jsonStream
}

function getPrettyStream(): DestinationStream {
	if (prettyStream) return prettyStream
	prettyStream = pinoPretty({
		colorize: true,
		ignore: 'pid,hostname,pluginId,context,caller',
		messageFormat: (log, messageKey) => {
			const msg = typeof log[messageKey] === 'string' ? log[messageKey] : ''
			const caller = typeof (log as any).caller === 'string' ? (log as any).caller : ''
			return caller ? `${msg} (${caller})` : msg
		},
		translateTime: 'SYS:standard',
	})
	return prettyStream
}

export function getDefaultStreams(level: string): PinoStream[] {
	return [
		{ level, stream: getJsonStream() },
		{ level, stream: getPrettyStream() },
	]
}
