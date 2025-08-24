// src/createLogger.ts
import fs from 'node:fs'
import path from 'node:path'
import { Writable } from 'node:stream'
import EventEmitter from 'node:events'
import * as rfs from 'rotating-file-stream'
import pino, { multistream, type Logger, type LoggerOptions } from 'pino'
import pinoCaller from 'pino-caller'
import pinoPretty from 'pino-pretty'
import superjson from 'superjson'

/** ---------- Structured record ---------- */
export interface LogRecord {
	time: string
	level: number | string
	name?: string
	msg: string
	[key: string]: any
}

/** ---------- Ring buffer + events ---------- */
const RING_SIZE = 500 as const
const ring: Array<LogRecord | undefined> = new Array(RING_SIZE)
let ringPtr = 0

export const events = new EventEmitter()
events.setMaxListeners(1000)

function pushRecord(rec: LogRecord) {
	ring[ringPtr] = rec
	ringPtr = (ringPtr + 1) % RING_SIZE
	events.emit('new_log', rec)
}

/** Get ordered logs (oldest -> newest) */
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

/** ---------- Log dir + rotating file ---------- */
const LOG_DIR = path.resolve(process.cwd(), 'logs')
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true })

// 每次启动新文件 + 按天轮转，保留 7 天
const rotatingStream = rfs.createStream(
	() => `app-${new Date().toISOString().replace(/[:.]/g, '-')}.log`,
	{ interval: '1d', path: LOG_DIR, maxFiles: 7 },
)

/** ---------- JSON stream: feed ring + file ---------- */
const jsonStream = new Writable({
	write(chunk, _enc, cb) {
		const line = chunk.toString()
		try {
			const obj = JSON.parse(line) as LogRecord
			// 只做浅层规范化，避免误触发复杂 getter
			pushRecord({
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

/** ---------- superjson-driven hook (Error 直通 + 只读参数安全) ---------- */
type IncludeMeta = 'none' | 'root'
interface SuperjsonHookOptions {
	includeMeta?: IncludeMeta
	transformAllObjects?: boolean // 当首参是字符串时，是否转换后续对象实参
}

/**
 * 将 Map/Set/BigInt/Date 等交给 superjson 做 JSON 化，
 * 同时保留 pino 的 Error 专用通道（.info(err, msg) 带完整 stack）。
 * 重要：不修改只读的 args，改用克隆后的新数组。
 */
function superjsonLogHook(
	opts: SuperjsonHookOptions = {},
): NonNullable<LoggerOptions['hooks']>['logMethod'] {
	const { includeMeta = 'none', transformAllObjects = false } = opts

	const transform = (val: unknown) => {
		if (val instanceof Error) return val // 关键：让 pino 自己处理 Error（保住 stack/type/cause）

		if (val === null || typeof val !== 'object') return val

		const { json, meta } = superjson.serialize(val)

		if (includeMeta === 'none') {
			if (json && typeof json === 'object' && !Array.isArray(json)) {
				return json as Record<string, unknown>
			}
			return { value: json }
		}

		// includeMeta === 'root'：把 meta 附在根部 __meta，便于可观测端识别原类型
		const root =
			json && typeof json === 'object' && !Array.isArray(json)
				? (json as Record<string, unknown>)
				: ({ value: json } as Record<string, unknown>)
		if (meta && Object.keys(meta).length) root.__meta = meta
		return root
	}

	return function (args, method) {
		if (!args || args.length === 0) return method.apply(this, args)

		// —— 不直接写只读的 args；克隆一份 —— //
		const newArgs = Array.prototype.slice.call(args) as unknown[]

		if (typeof newArgs[0] === 'string') {
			if (transformAllObjects) {
				for (let i = 1; i < newArgs.length; i++) {
					newArgs[i] = transform(newArgs[i])
				}
			}
		} else {
			newArgs[0] = transform(newArgs[0])
			if (transformAllObjects) {
				for (let i = 1; i < newArgs.length; i++) {
					newArgs[i] = transform(newArgs[i])
				}
			}
		}

		return method.apply(this, newArgs as unknown[])
	}
}

/** ---------- Factory ---------- */
/**
 * 创建 Logger：
 * - 结构化日志 → jsonStream（写环缓与事件，同时落 rotating file）
 * - 控制台输出 → prettyStream
 * - Map/Set/BigInt/Date → superjson in hooks
 * - Error → 保持 pino 原生序列化（stack 不丢）
 * - ✅ 不再写只读的 args（修复 TS “readonly 参数” 报错）
 */
export function createLogger(opts: LoggerOptions): Logger {
	const level = opts.level ?? 'info'
	const streams = [
		{ level, stream: jsonStream },
		{ level, stream: prettyStream },
	]

	const base = pino(
		{
			...opts,
			// 如果你常写 logger.info({ err }), 这能确保 err 与 cause 带 stack
			serializers: { err: pino.stdSerializers.err, ...opts.serializers },
			hooks: {
				logMethod: superjsonLogHook({
					includeMeta: 'none', // 如需在日志里看到 superjson 的 meta，改为 'root'
					transformAllObjects: false, // 一般 false，避免无谓开销
				}),
				...opts.hooks,
			},
		},
		multistream(streams),
	)

	// 可选：保留 caller 信息（文件/行号）
	return pinoCaller(base)
}

export type { Logger }
