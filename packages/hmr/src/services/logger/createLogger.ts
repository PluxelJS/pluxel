// src/createLogger.ts

import EventEmitter from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { Writable } from 'node:stream'
import pino, { type Logger, type LoggerOptions, multistream } from 'pino'
import pinoCaller from 'pino-caller'
import pinoPretty from 'pino-pretty'
import * as rfs from 'rotating-file-stream'
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

/** ---------- superjson helpers ---------- */
type IncludeMeta = 'none' | 'root'
interface SuperjsonHookOptions {
	includeMeta?: IncludeMeta
	transformAllObjects?: boolean
}

// 保持你现有“无 meta”默认；需要 meta 时可以把 includeMeta 改 'root'
const toPlain = (val: unknown, includeMeta: IncludeMeta = 'none'): unknown => {
	if (val === null || typeof val !== 'object') return val
	const { json, meta } = superjson.serialize(val)
	if (includeMeta === 'none') return json
	if (json && typeof json === 'object' && !Array.isArray(json)) {
		const root = json as Record<string, unknown>
		if (meta && Object.keys(meta).length) (root as any).__meta = meta
		return root
	}
	return { value: json, __meta: meta }
}

/** ---------- Error 专用序列化（保 stack/cause + 兼容复杂字段） ---------- */
function makeErrSerializer(includeMeta: IncludeMeta = 'none') {
	const visit = (e: unknown): any => {
		if (!(e instanceof Error)) return toPlain(e, includeMeta)
		// 1) 标准错误字段（message/name/stack/cause/type……）
		const out: any = pino.stdSerializers.err(e as any)

		// 2) 合并 Error 上“自定义可枚举字段”（比如 data/context 等）
		for (const k of Object.keys(e as any)) {
			if (k in out) continue
			try {
				;(out as any)[k] = toPlain((e as any)[k], includeMeta)
			} catch {
				/* 忽略不可序列化字段 */
			}
		}

		// 3) 深处理 cause
		const c = (e as any).cause
		if (c instanceof Error) out.cause = visit(c)
		else if (c !== undefined) out.cause = toPlain(c, includeMeta)

		return out
	}
	return visit
}

/** ---------- superjson-driven hook（升级：抬升 Error） ---------- */
function superjsonLogHook(
	opts: SuperjsonHookOptions = {},
): NonNullable<LoggerOptions['hooks']>['logMethod'] {
	const { includeMeta = 'none', transformAllObjects = false } = opts
	const transform = (v: unknown) => {
		if (v instanceof Error) return v // 让 err serializer 处理
		if (v === null || typeof v !== 'object') return v
		return toPlain(v, includeMeta)
	}

	return function (args, method) {
		if (!args || args.length === 0) return method.apply(this, args)

		// 克隆，避免写只读参数
		const newArgs = Array.prototype.slice.call(args) as unknown[]

		if (typeof newArgs[0] === 'string') {
			// A) 'msg', ...rest
			//   —— 仅在必要时抬升第一个 Error 到对象位，确保走 serializers.err
			let errIdx = -1
			for (let i = 1; i < newArgs.length; i++) {
				if (newArgs[i] instanceof Error) {
					errIdx = i
					break
				}
			}
			if (errIdx !== -1) {
				const err = newArgs.splice(errIdx, 1)[0]
				newArgs.unshift({ err }) // 变为 (obj, msg, ...)
			}
			if (transformAllObjects) {
				for (let i = 1; i < newArgs.length; i++) newArgs[i] = transform(newArgs[i])
			}
		} else {
			// B) obj, msg?
			newArgs[0] = transform(newArgs[0])
			if (transformAllObjects) {
				for (let i = 1; i < newArgs.length; i++) newArgs[i] = transform(newArgs[i])
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
	return pinoCaller(base, {
		relativeTo: process.cwd(), // 控制台更好读
		stackAdjustment: isBun ? 0 : 1, // 若仍指到 createLogger.ts，改成 2 试试
	})
}

export type { Logger }
