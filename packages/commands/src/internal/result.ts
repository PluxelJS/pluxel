import type { Result as BetterResult } from 'better-result'
import type { CommandFailure } from '../types'

/** Shared execution-boundary check; callers supervise throwing property access. */
export function isCommandResult(value: unknown): value is BetterResult<unknown, CommandFailure> {
	return isResult(value) && (value.status === 'ok' || validFailure(value.error))
}

function validFailure(value: unknown): value is CommandFailure {
	if (!value || typeof value !== 'object') return false
	const record = value as Record<string, unknown>
	if (typeof record.message !== 'string') return false
	switch (record.code) {
		case 'INPUT_VALIDATION':
			return (
				Array.isArray(record.issues) &&
				record.issues.every((item: unknown) => {
					if (!item || typeof item !== 'object') return false
					const issue = item as Record<string, unknown>
					return (
						typeof issue.message === 'string' &&
						(issue.code === undefined || typeof issue.code === 'string') &&
						(issue.path === undefined ||
							(Array.isArray(issue.path) &&
								issue.path.every((part) => typeof part === 'string' || typeof part === 'number')))
					)
				})
			)
		case 'REJECTED':
			return typeof record.reason === 'string'
		case 'FORBIDDEN':
		case 'COMMAND_NOT_FOUND':
		case 'PUBLICATION_GONE':
		case 'ABORTED':
		case 'TIMEOUT':
		case 'DEPENDENCY':
		case 'INTERNAL':
		case 'OUTPUT_ENCODING':
		case 'OUTPUT_LIMIT':
			return true
		default:
			return false
	}
}

function isResult(value: unknown): value is BetterResult<unknown, unknown> {
	if (!value || typeof value !== 'object') return false
	const result = value as Record<string, unknown>
	if (typeof result.isOk !== 'function' || typeof result.isErr !== 'function') return false
	if (result.status === 'ok') {
		return result.isOk() === true && result.isErr() === false && Object.hasOwn(result, 'value')
	}
	if (result.status === 'error') {
		return result.isOk() === false && result.isErr() === true && Object.hasOwn(result, 'error')
	}
	return false
}
