import { compareLogLevel, type LogLevel, type LogRecord, type Sink } from '@logtape/logtape'
import { captureCaller, formatLogName, pluxelReservedLogPropertyKeySet } from '@pluxel/core/logger'
import type { RuntimeLogError, RuntimeLogLine } from './protocol'
import { toPlainObject } from './serialization'
import { runtimeLogStores } from './store'

type RuntimeLogSinkCaps = {
	/** Max chars for the derived `msg` (primary list). Defaults to 4000. */
	maxMsgChars?: number
	/** Max structured message parts to keep. Defaults to 16. */
	maxMessageParts?: number
	/** Max chars per message string part. Defaults to 4000. */
	maxMessagePartChars?: number
	/** Max number of `props` keys to persist (after hidden/redact filtering). Defaults to 80. */
	maxPropsKeys?: number
}

const DEFAULT_CAPS: Required<RuntimeLogSinkCaps> = {
	maxMsgChars: 4000,
	maxMessageParts: 16,
	maxMessagePartChars: 4000,
	maxPropsKeys: 80,
}

function clampInt(n: unknown, fallback: number, min: number, max: number): number {
	if (typeof n !== 'number' || !Number.isFinite(n)) return fallback
	const v = Math.floor(n)
	return Math.min(max, Math.max(min, v))
}

function sanitizeMessageParts(
	message: readonly unknown[],
	seen: WeakSet<object>,
	caps: Required<RuntimeLogSinkCaps>,
): unknown[] | undefined {
	if (!message.length) return undefined
	const n = Math.min(message.length, caps.maxMessageParts)
	const out = new Array<unknown>(n)
	for (let i = 0; i < n; i++) {
		const part = message[i]
		if (typeof part === 'string')
			out[i] =
				part.length > caps.maxMessagePartChars
					? `${part.slice(0, caps.maxMessagePartChars)}…`
					: part
		else if (typeof part === 'number' || typeof part === 'boolean' || typeof part === 'bigint')
			out[i] = part
		else if (part === null || part === undefined) out[i] = part
		else if (part instanceof Error) out[i] = part.message || part.name
		else out[i] = toPlainObject(part, 4, seen)
	}
	return out
}

function deriveFastMsg(
	message: readonly unknown[] | undefined,
	caps: Required<RuntimeLogSinkCaps>,
): string {
	if (!message?.length) return ''
	let out = ''
	const n = Math.min(message.length, caps.maxMessageParts)
	for (let i = 0; i < n; i++) {
		if (out.length >= caps.maxMsgChars) break
		const part = message[i]
		if (typeof part === 'string') {
			const s =
				part.length > caps.maxMessagePartChars
					? `${part.slice(0, caps.maxMessagePartChars)}…`
					: part
			out += s
		} else if (typeof part === 'number' || typeof part === 'boolean' || typeof part === 'bigint')
			out += String(part)
		else if (part === null || part === undefined) out += String(part)
		else if (part instanceof Error) out += part.message || part.name
		else if (typeof part === 'function') {
			const name = (part as { name?: unknown }).name
			out += `[Function ${typeof name === 'string' && name ? name : 'anonymous'}]`
		} else if (typeof part === 'symbol') out += part.toString()
		else if (Array.isArray(part)) out += `[Array(${part.length})]`
		else if (typeof part === 'object') out += '[Object]'
		else out += String(part)
	}
	if (out.length <= caps.maxMsgChars) return out
	return `${out.slice(0, Math.max(0, caps.maxMsgChars - 1))}…`
}

function isErrorLike(v: unknown): v is { name?: unknown; message?: unknown; stack?: unknown } {
	return (
		!!v &&
		typeof v === 'object' &&
		('message' in (v as any) || 'stack' in (v as any) || 'name' in (v as any))
	)
}

function extractErrorLike(value: unknown, seen: WeakSet<object>): RuntimeLogError | undefined {
	if (value instanceof Error) return toPlainObject(value, 6, seen) as RuntimeLogError
	if (!isErrorLike(value)) return undefined
	return toPlainObject(value, 6, seen) as RuntimeLogError
}

export type RuntimeLogSinkOptions = {
	streamId?: string
	minLevel?: LogLevel

	/**
	 * Non-blocking batching. Aligns with LogTape sink guidance.
	 *
	 * Defaults: bufferSize=1000, flushIntervalMs=80.
	 */
	bufferSize?: number
	flushIntervalMs?: number

	/** In-memory retention window (lines). Default 200_000. */
	windowLines?: number

	/** Drop/compute caller in `props`. Default false. */
	includeCaller?: boolean

	/** Never persist these top-level prop keys. */
	hiddenKeys?: string[]
	/** Persist these top-level prop keys as "[REDACTED]". */
	redactKeys?: string[]

	/** Keep a best-effort raw record snapshot in `raw`. Default false. */
	includeRaw?: boolean

	/** Safety caps for UI payload size (independent from LogTape sinks). */
	caps?: RuntimeLogSinkCaps
}

function pickExtraProps(
	raw: Record<string, unknown>,
	opts: {
		includeCaller: boolean
		hiddenKeys: Set<string>
		redactKeys: Set<string>
		maxPropsKeys: number
	},
	seen: WeakSet<object>,
): Record<string, unknown> | undefined {
	let out: Record<string, unknown> | undefined

	if (opts.includeCaller) {
		const existing = raw.caller
		if (typeof existing === 'string') {
			;(out ??= {}).caller = existing
		} else {
			const captured = captureCaller({ exclude: pickExtraProps })
			if (captured) (out ??= {}).caller = captured
		}
	}

	let kept = 0
	for (const k in raw) {
		if (!Object.hasOwn(raw, k)) continue
		if (pluxelReservedLogPropertyKeySet.has(k) && (k !== 'caller' || !opts.includeCaller)) continue
		if (k === 'caller' && typeof raw[k] !== 'string' && !opts.includeCaller) continue
		if (opts.hiddenKeys.has(k)) continue
		if (opts.redactKeys.has(k)) {
			;(out ??= {})[k] = '[REDACTED]'
			continue
		}
		if (kept++ >= opts.maxPropsKeys) break
		;(out ??= {})[k] = toPlainObject(raw[k], 4, seen)
	}
	return out
}

function toRuntimeLogLineInput(
	record: LogRecord,
	opts: {
		includeCaller: boolean
		hiddenKeys: Set<string>
		redactKeys: Set<string>
		includeRaw: boolean
		caps: Required<RuntimeLogSinkCaps>
	},
): Omit<RuntimeLogLine, 'epoch' | 'seq' | 'streamId'> {
	const ts = record.timestamp
	const seen = new WeakSet<object>()
	const message = sanitizeMessageParts(record.message, seen, opts.caps)
	const msg = deriveFastMsg(record.message, opts.caps)

	const rawProps =
		record.properties && typeof record.properties === 'object'
			? (record.properties as Record<string, unknown>)
			: (Object.create(null) as Record<string, unknown>)

	const pluginId = typeof rawProps.pluginId === 'string' ? (rawProps.pluginId as string) : undefined
	const context = typeof rawProps.context === 'string' ? (rawProps.context as string) : undefined
	const name =
		typeof rawProps.name === 'string'
			? (rawProps.name as string)
			: pluginId && context
				? formatLogName(context, pluginId)
				: context

	const props = pickExtraProps(
		rawProps,
		{
			includeCaller: opts.includeCaller,
			hiddenKeys: opts.hiddenKeys,
			redactKeys: opts.redactKeys,
			maxPropsKeys: opts.caps.maxPropsKeys,
		},
		seen,
	)

	let error: RuntimeLogError | undefined
	if (rawProps.error !== undefined) error = extractErrorLike(rawProps.error, seen)
	if (!error && rawProps.err !== undefined) error = extractErrorLike(rawProps.err, seen)
	if (!error && rawProps.cause !== undefined) error = extractErrorLike(rawProps.cause, seen)

	const raw = opts.includeRaw
		? toPlainObject(
				{
					timestamp: record.timestamp,
					level: record.level,
					category: Array.from(record.category),
					message,
					properties: props,
				},
				6,
				seen,
			)
		: undefined

	return {
		ts,
		level: record.level,
		category: Array.from(record.category),
		name,
		pluginId,
		context,
		msg,
		message,
		props,
		error,
		raw,
	}
}

/**
 * Create a LogTape sink that normalizes records into `RuntimeLogLine` and appends
 * to the in-memory runtime log store.
 */
export function createRuntimeLogSink(options: RuntimeLogSinkOptions = {}): Sink {
	const streamId = options.streamId ?? 'default'
	const minLevel = options.minLevel ?? 'trace'
	const bufferSize = Math.min(Math.max(1, Math.floor(options.bufferSize ?? 1000)), 50_000)
	const flushIntervalMs = Math.min(Math.max(0, Math.floor(options.flushIntervalMs ?? 80)), 60_000)
	const windowLines =
		typeof options.windowLines === 'number'
			? clampInt(options.windowLines, 200_000, 1, 2_000_000)
			: undefined

	const hiddenKeys = new Set((options.hiddenKeys ?? []).filter(Boolean))
	const redactKeys = new Set((options.redactKeys ?? []).filter(Boolean))
	const includeCaller = options.includeCaller ?? false
	const includeRaw = options.includeRaw ?? false

	const caps: Required<RuntimeLogSinkCaps> = {
		...DEFAULT_CAPS,
		...(options.caps ?? {}),
		maxMsgChars: clampInt(options.caps?.maxMsgChars, DEFAULT_CAPS.maxMsgChars, 100, 200_000),
		maxMessageParts: clampInt(options.caps?.maxMessageParts, DEFAULT_CAPS.maxMessageParts, 1, 200),
		maxMessagePartChars: clampInt(
			options.caps?.maxMessagePartChars,
			DEFAULT_CAPS.maxMessagePartChars,
			100,
			200_000,
		),
		maxPropsKeys: clampInt(options.caps?.maxPropsKeys, DEFAULT_CAPS.maxPropsKeys, 0, 10_000),
	}

	let buf: Array<Omit<RuntimeLogLine, 'epoch' | 'seq' | 'streamId'>> = []
	let timer: ReturnType<typeof setTimeout> | null = null
	let flushing = false

	const flush = () => {
		if (flushing) return
		if (timer) {
			clearTimeout(timer)
			timer = null
		}
		if (!buf.length) return
		flushing = true
		const batch = buf
		buf = []
		try {
			const store = runtimeLogStores.getOrCreate(streamId, { windowLines })
			store.append(batch)
		} catch {
			// Sink failures must never break app logging.
		} finally {
			flushing = false
		}
	}

	const schedule = () => {
		if (flushIntervalMs <= 0) return
		if (timer) return
		timer = setTimeout(flush, flushIntervalMs)
	}

	return (record) => {
		try {
			if (compareLogLevel(record.level, minLevel) < 0) return
			buf.push(
				toRuntimeLogLineInput(record, {
					includeCaller,
					hiddenKeys,
					redactKeys,
					includeRaw,
					caps,
				}),
			)
			if (buf.length >= bufferSize) {
				flush()
			} else {
				schedule()
			}
		} catch {
			// Ignore.
		}
	}
}

/**
 * Backward-compatible alias (name reflects old "UI log store" implementation).
 */
export const createLogStoreSink = createRuntimeLogSink
