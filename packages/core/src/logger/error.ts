import type { LogRecord } from '@logtape/logtape'

export function findErrorInProps(record: LogRecord): unknown {
	const props = record.properties
	if (!props || typeof props !== 'object') return undefined
	const p = props as Record<string, unknown>
	if ('error' in p) return p.error
	if ('err' in p) return p.err
	return undefined
}

export function findErrorInMessage(record: LogRecord): unknown {
	for (let i = 1; i < record.message.length; i += 2) {
		const v = record.message[i]
		if (v instanceof Error) return v
	}
	return undefined
}

export function findErrorInRecord(record: LogRecord): unknown {
	return findErrorInProps(record) ?? findErrorInMessage(record)
}

export function omitErrorProps(record: LogRecord): LogRecord {
	const props = record.properties
	if (!props || typeof props !== 'object') return record
	const p = props as Record<string, unknown>
	if (!('error' in p) && !('err' in p)) return record
	const { error: _error, err: _err, ...rest } = p
	return { ...record, properties: rest } as LogRecord
}

export function formatErrorStack(error: Error): string {
	const stack =
		typeof error.stack === 'string' && error.stack.length > 0
			? error.stack
			: `${error.name || 'Error'}: ${error.message || String(error)}`
	// Avoid pathological payloads flooding the console / UI.
	const limit = 20_000
	return stack.length > limit ? `${stack.slice(0, limit)}…` : stack
}
