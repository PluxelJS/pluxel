import { compareLogLevel, type LogLevel, type LogRecord, type Sink } from '@logtape/logtape'

import { formatLogName } from './logName'
import { logStore, type UiLogRecord } from './logStore'
import { messageToString, toPlainObject } from './serialization'

export type LogStoreSinkOptions = {
	minLevel?: LogLevel
	/** Drop `caller` from the stored/log-streamed properties (recommended for UI). */
	includeCaller?: boolean
}

const RESERVED_PROP_KEYS = new Set(['pluginId', 'context', 'name', 'caller'])

function pickExtraProps(
	raw: Record<string, unknown>,
	opts: { includeCaller: boolean },
): Record<string, unknown> | undefined {
	const out: Record<string, unknown> = {}
	for (const [k, v] of Object.entries(raw)) {
		if (RESERVED_PROP_KEYS.has(k) && (k !== 'caller' || !opts.includeCaller)) continue
		out[k] = v
	}
	return Object.keys(out).length ? out : undefined
}

export function toUiLogRecord(
	record: LogRecord,
	opts: { includeCaller: boolean } = { includeCaller: false },
): Omit<UiLogRecord, 'id'> {
	const time = record.timestamp
	const msg = messageToString(record.message)

	const pluginId =
		typeof record.properties.pluginId === 'string' ? (record.properties.pluginId as string) : undefined
	const context =
		typeof record.properties.context === 'string' ? (record.properties.context as string) : undefined
	const name =
		typeof record.properties.name === 'string'
			? (record.properties.name as string)
			: pluginId && context
				? formatLogName(context, pluginId)
				: context

	const safeProps = toPlainObject(record.properties) as Record<string, unknown>
	const props = pickExtraProps(safeProps, opts)
	return {
		time,
		level: record.level,
		name,
		pluginId,
		context,
		msg,
		category: record.category,
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
