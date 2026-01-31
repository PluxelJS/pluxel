import { compareLogLevel, type LogLevel, type LogRecord, type Sink } from '@logtape/logtape'
import { captureCaller, formatLogName, pluxelReservedLogPropertyKeySet } from '@pluxel/core/logger'

import { logStore, type UiLogRecord } from './logStore'
import { toPlainObject } from './serialization'

function sanitizeMessageParts(
	message: readonly unknown[],
	seen: WeakSet<object>,
): unknown[] | undefined {
	if (!message.length) return undefined
	const out = new Array<unknown>(message.length)
	for (let i = 0; i < message.length; i++) {
		const part = message[i]
		if (typeof part === 'string') out[i] = part.length > 4000 ? `${part.slice(0, 4000)}…` : part
		else if (typeof part === 'number' || typeof part === 'boolean' || typeof part === 'bigint')
			out[i] = part
		else if (part === null || part === undefined) out[i] = part
		// Keep parity with the old `messageToString()` behavior: Errors render as their message.
		else if (part instanceof Error) out[i] = part.message || part.name
		else out[i] = toPlainObject(part, 4, seen)
	}
	return out
}

// Fast legacy text: only join when all parts are primitive; avoid JSON.stringify of objects.
function deriveLegacyMsg(message?: readonly unknown[]): string {
	if (!message?.length) return ''
	let out = ''
	for (let i = 0; i < message.length; i++) {
		const part = message[i]
		if (typeof part === 'string') out += part.length > 4000 ? `${part.slice(0, 4000)}…` : part
		else if (typeof part === 'number' || typeof part === 'boolean' || typeof part === 'bigint')
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
	return out
}

export type LogStoreSinkOptions = {
	minLevel?: LogLevel
	/** Drop `caller` from the stored/log-streamed properties (recommended for UI). */
	includeCaller?: boolean
}

function pickExtraProps(
	raw: Record<string, unknown>,
	opts: { includeCaller: boolean },
	seen: WeakSet<object>,
): Record<string, unknown> | undefined {
	let out: Record<string, unknown> | undefined

	// When callers explicitly want callsites in the UI, compute it on demand.
	// This keeps the default logging path cheap and avoids the "lazy properties resolved by filters" trap.
	if (opts.includeCaller) {
		const existing = raw.caller
		if (typeof existing === 'string') {
			;(out ??= {}).caller = existing
		} else {
			const captured = captureCaller({ exclude: pickExtraProps })
			if (captured) (out ??= {}).caller = captured
		}
	}

	for (const k in raw) {
		if (!Object.hasOwn(raw, k)) continue
		if (pluxelReservedLogPropertyKeySet.has(k) && (k !== 'caller' || !opts.includeCaller)) continue
		// Only persist caller when it's a stable, explicit string (otherwise we computed it above).
		if (k === 'caller' && typeof raw[k] !== 'string') continue
		;(out ??= {})[k] = toPlainObject(raw[k], 4, seen)
	}
	return out
}

export function toUiLogRecord(
	record: LogRecord,
	opts: { includeCaller: boolean } = { includeCaller: false },
): Omit<UiLogRecord, 'id'> {
	const time = record.timestamp
	const seen = new WeakSet<object>()
	const message = sanitizeMessageParts(record.message, seen)
	const msg = deriveLegacyMsg(record.message)

	// Treat LogTape properties as potentially-lazy; read once.
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

	const props = pickExtraProps(rawProps, opts, seen)
	return {
		time,
		level: record.level,
		name,
		pluginId,
		context,
		msg,
		message,
		category: Array.from(record.category),
		props,
	}
}

export function createLogStoreSink(opts: LogStoreSinkOptions = {}): Sink {
	const minLevel = opts.minLevel ?? 'trace'
	const includeCaller = opts.includeCaller ?? false
	return (record) => {
		if (compareLogLevel(record.level, minLevel) < 0) return
		logStore.push(toUiLogRecord(record, { includeCaller }))
	}
}
