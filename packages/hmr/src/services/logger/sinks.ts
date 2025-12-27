import fs from 'node:fs'
import path from 'node:path'
import { Writable } from 'node:stream'
import type { DestinationStream } from 'pino'
import * as rfs from 'rotating-file-stream'

import { type LogRecord, logStore } from './logStore'
import type { LoggerStoreConfig, ResolvedLoggerRuntimeConfig } from './loggerRuntimeConfig'
import { getPrettyStream } from './pretty/stream'

type PinoStream = { level: string; stream: DestinationStream }

const DEFAULT_LOG_DIR = path.resolve(process.cwd(), 'logs')
const RETENTION_DAYS = 7

const LEVEL_NUMBERS: Record<string, number> = {
	trace: 10,
	debug: 20,
	info: 30,
	warn: 40,
	error: 50,
	fatal: 60,
}

let rotatingStream: NodeJS.WritableStream | undefined
let jsonStream: Writable | undefined
let storeEnabled = true
let storeMinLevelNumber = LEVEL_NUMBERS.trace
let storeLevelCheck = false
let storeMinLevel: LoggerStoreConfig['minLevel'] = 'trace'

function applyStoreConfig(config: LoggerStoreConfig) {
	if (config.enabled === storeEnabled && config.minLevel === storeMinLevel) return
	storeEnabled = config.enabled
	storeMinLevel = config.minLevel
	storeMinLevelNumber = LEVEL_NUMBERS[config.minLevel] ?? LEVEL_NUMBERS.trace
	storeLevelCheck = storeEnabled && storeMinLevelNumber > LEVEL_NUMBERS.trace
}

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
			if (storeEnabled) {
				let shouldStore = true
				if (storeLevelCheck) {
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
						if (Number.isFinite(levelValue) && levelValue < storeMinLevelNumber) {
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

export function getDefaultStreams(level: string, runtime: ResolvedLoggerRuntimeConfig): PinoStream[] {
	applyStoreConfig(runtime.store)
	const streams: PinoStream[] = [{ level, stream: getJsonStream() }]
	if (runtime.pretty.enabled) {
		streams.push({ level, stream: getPrettyStream() })
	}
	return streams
}
