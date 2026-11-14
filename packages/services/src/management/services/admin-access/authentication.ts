import type {
	ManagementAuthenticationProviderStep,
	ManagementAuthenticationChallenge,
	ManagementAuthenticationFailureCode,
} from './types'
import { ADMIN_ACCESS_OIDC_START_PATH } from './transport'

/** @internal Closed data projection shared by provider admission and the RPC producer. */
export function providerStepSnapshot(value: unknown): ManagementAuthenticationProviderStep {
	const input = readRecord(value, 'authentication step')
	switch (input.kind) {
		case 'challenge': {
			assertExactKeys(input, ['kind', 'challenge'], 'authentication challenge step')
			return Object.freeze({ kind: 'challenge', challenge: challengeSnapshot(input.challenge) })
		}
		case 'navigate': {
			assertExactKeys(input, ['kind', 'path'], 'authentication navigation step')
			if (input.path !== ADMIN_ACCESS_OIDC_START_PATH) {
				throw new TypeError('authentication navigation path is invalid')
			}
			return Object.freeze({ kind: 'navigate', path: ADMIN_ACCESS_OIDC_START_PATH })
		}
		case 'authenticated': {
			assertOnlyKeys(input, ['kind', 'principal', 'cookieCommit'], 'authenticated step')
			if (!Object.hasOwn(input, 'principal')) {
				throw new TypeError('authenticated step.principal is required')
			}
			const principal = principalSnapshot(input.principal)
			if (input.cookieCommit === undefined) {
				return Object.freeze({ kind: 'authenticated', principal })
			}
			const commit = readRecord(input.cookieCommit, 'cookie commit ticket')
			assertExactKeys(commit, ['ticket', 'expiresAt'], 'cookie commit ticket')
			const ticket = boundedText(commit.ticket, 4096)
			if (!ticket || !Number.isSafeInteger(commit.expiresAt) || Number(commit.expiresAt) <= 0) {
				throw new TypeError('cookie commit ticket is invalid')
			}
			return Object.freeze({
				kind: 'authenticated',
				principal,
				cookieCommit: Object.freeze({ ticket, expiresAt: Number(commit.expiresAt) }),
			})
		}
		case 'failed': {
			assertExactKeys(input, ['kind', 'code'], 'authentication failure step')
			if (!isAuthenticationFailureCode(input.code)) {
				throw new TypeError('authentication failure code is invalid')
			}
			return Object.freeze({ kind: 'failed', code: input.code })
		}
		default:
			throw new TypeError('authentication step.kind is invalid')
	}
}

function challengeSnapshot(value: unknown): ManagementAuthenticationChallenge {
	const input = readRecord(value, 'authentication challenge')
	if (input.kind === 'password') {
		assertOnlyKeys(input, ['kind', 'label'], 'password challenge')
		const label = input.label === undefined ? undefined : boundedText(input.label, 128)
		if (input.label !== undefined && !label)
			throw new TypeError('password challenge.label is invalid')
		return Object.freeze({ kind: 'password', ...(label ? { label } : {}) })
	}
	if (input.kind === 'totp') {
		assertExactKeys(input, ['kind', 'digits'], 'TOTP challenge')
		if (input.digits !== 6) throw new TypeError('TOTP challenge.digits must be 6')
		return Object.freeze({ kind: 'totp', digits: 6 })
	}
	throw new TypeError('authentication challenge.kind is invalid')
}

function principalSnapshot(value: unknown): Readonly<{ subject: string; displayName?: string }> {
	const input = readRecord(value, 'provider principal')
	assertOnlyKeys(input, ['subject', 'displayName'], 'provider principal')
	const subject = boundedText(input.subject, 512)
	if (!subject) throw new TypeError('provider principal.subject is invalid')
	const displayName =
		input.displayName === undefined ? undefined : boundedText(input.displayName, 256)
	if (input.displayName !== undefined && !displayName) {
		throw new TypeError('provider principal.displayName is invalid')
	}
	return Object.freeze({ subject, ...(displayName ? { displayName } : {}) })
}

export function readRecord(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError(`${label} must be an object`)
	}
	return value as Record<string, unknown>
}

export function boundedText(value: unknown, maxLength: number): string | undefined {
	if (typeof value !== 'string') return undefined
	const normalized = value.trim()
	return normalized && normalized.length <= maxLength ? normalized : undefined
}

export function assertExactKeys(
	value: Record<string, unknown>,
	expected: readonly string[],
	label: string,
): void {
	const keys = Object.keys(value)
	if (keys.length !== expected.length || !expected.every((key) => Object.hasOwn(value, key))) {
		throw new TypeError(`${label} has unknown or missing fields`)
	}
}

export function assertOnlyKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
	label: string,
): void {
	if (Object.keys(value).some((key) => !allowed.includes(key))) {
		throw new TypeError(`${label} has unknown fields`)
	}
}

function isAuthenticationFailureCode(value: unknown): value is ManagementAuthenticationFailureCode {
	return (
		value === 'authentication_failed' ||
		value === 'authentication_expired' ||
		value === 'access_unavailable' ||
		value === 'attempt_limited'
	)
}
