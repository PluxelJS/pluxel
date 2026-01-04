import type { Logger as LogtapeLogger } from '@logtape/logtape'

export type PluxelLogMethod = keyof Pick<
	LogtapeLogger,
	'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'
>

function isTemplateStringsArray(value: unknown): value is TemplateStringsArray {
	return Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, 'raw')
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== 'object') return false
	if (value instanceof Error) return false
	if (Array.isArray(value)) return false
	const proto = Object.getPrototypeOf(value)
	if (proto !== Object.prototype && proto !== null) return false
	return true
}

/**
 * Normalizes common call patterns into LogTape-friendly calls, while keeping
 * tagged template literals and lazy callbacks as-is.
 */
export function callLogtape(
	logger: LogtapeLogger,
	level: PluxelLogMethod,
	args: unknown[],
): void {
	const logFn = logger[level] as unknown as (...a: any[]) => void
	const [a0, a1, a2] = args

	if (typeof a0 === 'function' || isTemplateStringsArray(a0)) {
		logFn.apply(logger, args as any)
		return
	}

	if (a0 instanceof Error) {
		if (typeof a1 === 'string') {
			if (isPlainRecord(a2)) logFn.call(logger, a1, { ...a2, error: a0 })
			else logFn.call(logger, a1, { error: a0 })
			return
		}
		if (isPlainRecord(a1)) {
			logFn.call(logger, a0.message || 'Error', { ...a1, error: a0 })
			return
		}
		logFn.call(logger, a0.message || 'Error', { error: a0 })
		return
	}

	if (typeof a0 === 'string') {
		if (a1 instanceof Error) {
			if (isPlainRecord(a2)) logFn.call(logger, a0, { ...a2, error: a1 })
			else logFn.call(logger, a0, { error: a1 })
			return
		}
		if (isPlainRecord(a1) || typeof a1 === 'function') {
			logFn.call(logger, a0, a1 as any)
			return
		}
		if (args.length > 1) {
			logFn.call(logger, a0, { args: args.slice(1) })
			return
		}
		logFn.call(logger, a0)
		return
	}

	if (isPlainRecord(a0) && typeof a1 === 'string') {
		logFn.call(logger, a1, a0)
		return
	}

	logFn.apply(logger, args as any)
}
