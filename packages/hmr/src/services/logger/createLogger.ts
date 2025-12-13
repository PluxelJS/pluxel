// src/createLogger.ts

import pino, { type Logger, type LoggerOptions, multistream } from 'pino'
import { withCallerFormatters } from './caller'
/** ---------- Structured record + store ---------- */
import { logStore } from './logStore'
import {
	attachPrettyErrors,
	type PrettyErrorPayload,
	type PrettyErrorSink,
	writePrettyErrorToStderr,
} from './prettyErrors'
import { createDumperLogHook, makeErrSerializer } from './serialization'
import { getDefaultStreams } from './sinks'

export type { LogRecord } from './logStore'

export const events = logStore.events
export const getOrderedLogs = (limit = logStore.capacity) => logStore.snapshot(limit)

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
const versions = process?.versions as unknown as { bun?: string } | undefined
const isBun = !!versions?.bun
export function createLogger(opts: LoggerOptions): Logger {
	const level = opts.level ?? 'info'
	const streams = getDefaultStreams(level)

	const hooks = {
		...(opts.hooks ?? {}),
		logMethod: createDumperLogHook({
			transformAllObjects: false,
		}),
	} as LoggerOptions['hooks']

	const formatters = withCallerFormatters(opts.formatters, {
		relativeTo: process.cwd(),
		stackAdjustment: isBun ? 0 : 1,
	})

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
