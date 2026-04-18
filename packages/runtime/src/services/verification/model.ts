import type {
	VerificationConfig,
	VerificationMethod,
	VerificationOtpConfig,
	VerificationOtpUserStored,
	VerificationPasskeyConfig,
	VerificationPasskeyUserStored,
	VerificationPasswordConfig,
	VerificationPasswordUserStored,
	VerificationUser,
} from './types'

export const DEFAULT_VERIFICATION_MODE = 'bypass' as const
export const DEFAULT_VERIFICATION_METHOD = 'password' as const

type VerificationConfigLike =
	| {
			mode?: VerificationConfig['mode']
			method?: VerificationMethod
			users?: unknown
	  }
	| null
	| undefined

export function normalizeVerificationUsername(value: string): string {
	return value.trim()
}

export function requireVerificationPassword(value: string): string {
	if (value.trim().length === 0) throw new Error('Password is required.')
	return value
}

export function normalizeOtpCode(value: string): string {
	return value.replaceAll(/\s+/g, '')
}

function normalizePasswordUsers(value: unknown): VerificationPasswordUserStored[] {
	if (!Array.isArray(value)) return []
	const seen = new Set<string>()
	const users: VerificationPasswordUserStored[] = []
	for (const entry of value) {
		if (!entry || typeof entry !== 'object') continue
		const username = normalizeVerificationUsername(String((entry as { username?: unknown }).username ?? ''))
		const passwordHash = String((entry as { passwordHash?: unknown }).passwordHash ?? '').trim()
		if (!username || !passwordHash || seen.has(username)) continue
		seen.add(username)
		users.push({ username, passwordHash })
	}
	return users
}

function normalizeOtpUsers(value: unknown): VerificationOtpUserStored[] {
	if (!Array.isArray(value)) return []
	const seen = new Set<string>()
	const users: VerificationOtpUserStored[] = []
	for (const entry of value) {
		if (!entry || typeof entry !== 'object') continue
		const username = normalizeVerificationUsername(String((entry as { username?: unknown }).username ?? ''))
		const otpSecret = String((entry as { otpSecret?: unknown }).otpSecret ?? '').trim()
		if (!username || !otpSecret || seen.has(username)) continue
		seen.add(username)
		users.push({ username, otpSecret })
	}
	return users
}

function normalizePasskeyUsers(value: unknown): VerificationPasskeyUserStored[] {
	if (!Array.isArray(value)) return []
	const seen = new Set<string>()
	const users: VerificationPasskeyUserStored[] = []
	for (const entry of value) {
		if (!entry || typeof entry !== 'object') continue
		const username = normalizeVerificationUsername(String((entry as { username?: unknown }).username ?? ''))
		const credentialId = String((entry as { credentialId?: unknown }).credentialId ?? '').trim()
		const publicKey = String((entry as { publicKey?: unknown }).publicKey ?? '').trim()
		const counter = Number((entry as { counter?: unknown }).counter ?? 0)
		const transports = Array.isArray((entry as { transports?: unknown }).transports)
			? (entry as { transports?: unknown[] }).transports
					.map((transport) => String(transport ?? '').trim())
					.filter(Boolean)
			: undefined
		if (!username || !credentialId || !publicKey || !Number.isFinite(counter) || seen.has(username)) continue
		seen.add(username)
		users.push({
			username,
			credentialId,
			publicKey,
			counter: Math.max(0, Math.floor(counter)),
			...(transports && transports.length > 0 ? { transports } : {}),
		})
	}
	return users
}

export function resolveVerificationConfig(input?: VerificationConfigLike): VerificationConfig {
	const mode =
		input?.mode === 'enforce' || input?.mode === 'bypass'
			? input.mode
			: DEFAULT_VERIFICATION_MODE
	const method = input?.method ?? DEFAULT_VERIFICATION_METHOD
	const users = (input as { users?: unknown } | null | undefined)?.users
	switch (method) {
		case 'password':
			return {
				mode,
				method,
				users: normalizePasswordUsers(users),
			}
		case 'otp':
			return {
				mode,
				method,
				users: normalizeOtpUsers(users),
			}
		case 'passkey':
			return {
				mode,
				method,
				users: normalizePasskeyUsers(users),
			}
	}
}

export function listVerificationUsers(config: VerificationConfig): VerificationUser[] {
	return (config.users ?? []).map(({ username }) => ({ username }))
}

export function setVerificationConfigMode(
	config: VerificationConfig,
	mode: VerificationConfig['mode'],
): VerificationConfig {
	return {
		...config,
		mode,
	}
}

export function setVerificationConfigMethod(
	config: VerificationConfig,
	method: VerificationMethod,
): VerificationConfig {
	if (config.method === method) return config
	return { mode: config.mode, method, users: [] } as VerificationConfig
}

export function findPasswordUser(
	config: VerificationConfig,
	username: string,
): VerificationPasswordUserStored | undefined {
	if (config.method !== 'password') return undefined
	return config.users.find((entry) => entry.username === username)
}

export function findOtpUser(
	config: VerificationConfig,
	username: string,
): VerificationOtpUserStored | undefined {
	if (config.method !== 'otp') return undefined
	return config.users.find((entry) => entry.username === username)
}

export function findPasskeyUser(
	config: VerificationConfig,
	username: string,
): VerificationPasskeyUserStored | undefined {
	if (config.method !== 'passkey') return undefined
	return config.users.find((entry) => entry.username === username)
}

export function upsertPasswordUser(
	config: VerificationConfig,
	user: VerificationPasswordUserStored,
): VerificationPasswordConfig {
	if (config.method !== 'password') {
		throw new Error('Verification method must be password.')
	}
	return {
		...config,
		users: [...config.users.filter((entry) => entry.username !== user.username), user],
	}
}

export function upsertOtpUser(
	config: VerificationConfig,
	user: VerificationOtpUserStored,
): VerificationOtpConfig {
	if (config.method !== 'otp') {
		throw new Error('Verification method must be otp.')
	}
	return {
		...config,
		users: [...config.users.filter((entry) => entry.username !== user.username), user],
	}
}

export function upsertPasskeyUser(
	config: VerificationConfig,
	user: VerificationPasskeyUserStored,
): VerificationPasskeyConfig {
	if (config.method !== 'passkey') {
		throw new Error('Verification method must be passkey.')
	}
	return {
		...config,
		users: [...config.users.filter((entry) => entry.username !== user.username), user],
	}
}

export function deleteVerificationUser(
	config: VerificationConfig,
	username: string,
): VerificationConfig {
	return {
		...config,
		users: (config.users ?? []).filter((entry) => entry.username !== username),
	} as VerificationConfig
}
