import type { PackageServiceErrorCode } from './types'

export interface NormalizedUnknownError {
	error: unknown
	message: string
	stack?: string
}

export class PackageServiceError extends Error {
	override name = 'PackageServiceError'
	public readonly cause: unknown

	constructor(
		public readonly code: PackageServiceErrorCode,
		message: string,
		public readonly detail?: unknown,
	) {
		super(message)
		const cause = getErrorCause(detail)
		this.cause = detail instanceof Error ? detail : cause instanceof Error ? cause : undefined
	}
}

export function getErrorCause(value: unknown): unknown {
	if (!value || typeof value !== 'object') return undefined
	if (!('cause' in value)) return undefined
	return (value as { cause?: unknown }).cause
}

export function unwrapErrorCause(
	error: unknown,
	options?: { acceptNonErrorCause?: boolean },
): unknown {
	const cause = getErrorCause(error)
	if (cause instanceof Error) return cause
	if (options?.acceptNonErrorCause && cause !== undefined && cause !== null) return cause
	return error
}

export function normalizeUnknownError(error: unknown): NormalizedUnknownError {
	const unwrapped = unwrapErrorCause(error)
	if (unwrapped instanceof Error) {
		return { message: unwrapped.message, error: unwrapped, stack: unwrapped.stack }
	}
	if (typeof unwrapped === 'string') {
		return { message: unwrapped, error: unwrapped }
	}
	if (unwrapped === undefined || unwrapped === null) {
		return { message: '未知错误', error: unwrapped }
	}
	return {
		message: safeStringify(unwrapped) ?? String(unwrapped),
		error: unwrapped,
	}
}

export function formatUnknownErrorMessage(error: unknown, fallback = '未知错误'): string {
	const normalized = normalizeUnknownError(error)
	return normalized.message || fallback
}

export function getUnknownErrorStack(error: unknown): string | undefined {
	const unwrapped = unwrapErrorCause(error)
	if (unwrapped instanceof Error) return unwrapped.stack ?? unwrapped.message
	if (typeof unwrapped === 'string') return unwrapped
	return undefined
}

export function toError(error: unknown): Error {
	const normalized = normalizeUnknownError(error)
	if (normalized.error instanceof Error) return normalized.error
	const wrapped = new Error(normalized.message)
	if (normalized.stack) wrapped.stack = normalized.stack
	return wrapped
}

function safeStringify(value: unknown): string | undefined {
	try {
		return JSON.stringify(value, createSafeJsonReplacer())
	} catch {
		return undefined
	}
}

function createSafeJsonReplacer() {
	const seen = new WeakSet<object>()
	return (_key: string, value: unknown): unknown => {
		if (typeof value === 'bigint') return `${value}n`
		if (!value || typeof value !== 'object') return value
		if (seen.has(value)) return '[Circular]'
		seen.add(value)
		if (value instanceof Error) {
			return {
				name: value.name,
				message: value.message,
				stack: value.stack,
				cause: getErrorCause(value),
			}
		}
		return value
	}
}
