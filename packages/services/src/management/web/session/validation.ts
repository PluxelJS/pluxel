import type { RuntimeLogoutResult } from './protocol'

export function parseRuntimeLogoutResult(input: unknown): RuntimeLogoutResult {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		throw new TypeError('Runtime logout result must be an object')
	}
	const prototype = Object.getPrototypeOf(input)
	if (prototype !== null && prototype !== Object.prototype)
		throw new TypeError('Runtime logout result must be a plain object')
	for (const key of Reflect.ownKeys(input)) {
		if (
			typeof key !== 'string' ||
			!Object.hasOwn(Object.getOwnPropertyDescriptor(input, key)!, 'value')
		)
			throw new TypeError('Runtime logout result must contain only data fields')
	}
	const value = input as Record<string, unknown>
	if (value.kind === 'closed') {
		assertLogoutKeys(value, ['kind'])
		return Object.freeze({ kind: 'closed' })
	}
	if (value.kind !== 'cookie-commit-required') {
		throw new TypeError('Runtime logout result kind is invalid')
	}
	assertLogoutKeys(value, ['expiresAt', 'kind', 'ticket'])
	if (
		typeof value.ticket !== 'string' ||
		!value.ticket ||
		value.ticket.length > 4_096 ||
		!Number.isSafeInteger(value.expiresAt) ||
		Number(value.expiresAt) <= 0
	) {
		throw new TypeError('Runtime logout cookie commit is invalid')
	}
	return Object.freeze({
		kind: 'cookie-commit-required',
		ticket: value.ticket,
		expiresAt: Number(value.expiresAt),
	})
}

function assertLogoutKeys(input: Record<string, unknown>, expected: readonly string[]): void {
	const keys = Object.keys(input).sort()
	if (keys.length !== expected.length || expected.some((key, index) => keys[index] !== key)) {
		throw new TypeError('Runtime logout result has an invalid shape')
	}
}
