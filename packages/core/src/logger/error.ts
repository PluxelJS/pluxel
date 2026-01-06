import type { LogRecord } from '@logtape/logtape'

export function findErrorInProps(record: LogRecord): unknown {
	const props = record.properties as any
	if (props?.error) return props.error
	if (props?.err) return props.err
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
	const props = record.properties as Record<string, unknown>
	if (!props || typeof props !== 'object') return record
	if (!('error' in props) && !('err' in props)) return record
	const { error: _error, err: _err, ...rest } = props
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
