import { resolve } from 'pathe'
import type { FsService } from '../fs/FsService'
import {
	DEFAULT_VERIFICATION_METHOD,
	DEFAULT_VERIFICATION_MODE,
	normalizeVerificationUsername,
	resolveVerificationConfig,
} from '../verification/model'
import type {
	VerificationConfig,
	VerificationMethod,
	VerificationMode,
	VerificationOtpUserStored,
	VerificationPasskeyUserStored,
	VerificationPasswordUserStored,
} from '../verification/types'

export type SecurityIdentityDoc = {
	version: 1
	verification?: VerificationConfig
	vault?: {
		hostIdentity?: string
		deployRecipients?: string[]
	}
}

export const SECURITY_IDENTITY_RELATIVE_PATH = 'data/security/identity.json'

function emptyDoc(): SecurityIdentityDoc {
	return { version: 1 }
}

function trimOrUndefined(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined
	const trimmed = value.trim()
	return trimmed || undefined
}

function normalizeRecipients(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined
	const seen = new Set<string>()
	const recipients: string[] = []
	for (const entry of value) {
		const recipient = trimOrUndefined(entry)
		if (!recipient || seen.has(recipient)) continue
		seen.add(recipient)
		recipients.push(recipient)
	}
	return recipients.length > 0 ? recipients : undefined
}

function normalizeVerificationMode(value: unknown): VerificationMode | undefined {
	return value === 'bypass' || value === 'enforce' ? value : undefined
}

function normalizeVerificationMethod(value: unknown): VerificationMethod | undefined {
	return value === 'password' || value === 'otp' || value === 'passkey' ? value : undefined
}

function normalizeLegacyPasswordUser(value: {
	username?: unknown
	passwordHash?: unknown
} | undefined): VerificationPasswordUserStored[] {
	const username = normalizeVerificationUsername(String(value?.username ?? ''))
	const passwordHash = trimOrUndefined(value?.passwordHash)
	return username && passwordHash ? [{ username, passwordHash }] : []
}

function normalizePasswordUsers(value: unknown): VerificationPasswordUserStored[] {
	const config = resolveVerificationConfig({
		mode: DEFAULT_VERIFICATION_MODE,
		method: 'password',
		users: value as VerificationPasswordUserStored[] | undefined,
	})
	return config.method === 'password' ? config.users ?? [] : []
}

function normalizeOtpUsers(value: unknown): VerificationOtpUserStored[] {
	const config = resolveVerificationConfig({
		mode: DEFAULT_VERIFICATION_MODE,
		method: 'otp',
		users: value as VerificationOtpUserStored[] | undefined,
	})
	return config.method === 'otp' ? config.users ?? [] : []
}

function normalizePasskeyUsers(value: unknown): VerificationPasskeyUserStored[] {
	const config = resolveVerificationConfig({
		mode: DEFAULT_VERIFICATION_MODE,
		method: 'passkey',
		users: value as VerificationPasskeyUserStored[] | undefined,
	})
	return config.method === 'passkey' ? config.users ?? [] : []
}

function normalizeVerificationConfig(input: unknown): VerificationConfig | undefined {
	if (!input || typeof input !== 'object') return undefined
	const source = input as {
		mode?: unknown
		method?: unknown
		users?: unknown
		username?: unknown
		passwordHash?: unknown
	}
	const mode = normalizeVerificationMode(source.mode) ?? DEFAULT_VERIFICATION_MODE
	const method = normalizeVerificationMethod(source.method) ?? DEFAULT_VERIFICATION_METHOD
	switch (method) {
		case 'password': {
			const users = normalizePasswordUsers(source.users)
			const legacyUsers = users.length > 0 ? users : normalizeLegacyPasswordUser(source)
			return {
				mode,
				method,
				...(legacyUsers.length > 0 ? { users: legacyUsers } : {}),
			}
		}
		case 'otp': {
			const users = normalizeOtpUsers(source.users)
			return {
				mode,
				method,
				...(users.length > 0 ? { users } : {}),
			}
		}
		case 'passkey': {
			const users = normalizePasskeyUsers(source.users)
			return {
				mode,
				method,
				...(users.length > 0 ? { users } : {}),
			}
		}
	}
}

function normalizeDoc(input: unknown): SecurityIdentityDoc {
	if (!input || typeof input !== 'object') return emptyDoc()
	const source = input as {
		verification?: unknown
		vault?: { hostIdentity?: unknown; deployRecipients?: unknown }
	}
	const verification = normalizeVerificationConfig(source.verification)
	const hostIdentity = trimOrUndefined(source.vault?.hostIdentity)
	const deployRecipients = normalizeRecipients(source.vault?.deployRecipients)

	const doc: SecurityIdentityDoc = {
		version: 1,
	}

	if (verification) doc.verification = verification
	if (hostIdentity || deployRecipients) {
		doc.vault = {}
		if (hostIdentity) doc.vault.hostIdentity = hostIdentity
		if (deployRecipients) doc.vault.deployRecipients = deployRecipients
	}

	return doc
}

function parseDoc(raw: string): SecurityIdentityDoc {
	return normalizeDoc(JSON.parse(raw) as unknown)
}

function isMissing(error: unknown): boolean {
	return !!error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT'
}

function hasMaterial(doc: SecurityIdentityDoc): boolean {
	return !!(
		doc.verification ||
		doc.vault?.hostIdentity ||
		(doc.vault?.deployRecipients && doc.vault.deployRecipients.length > 0)
	)
}

export function securityIdentityPath(rootDir = process.cwd()): string {
	return resolve(rootDir, SECURITY_IDENTITY_RELATIVE_PATH)
}

export function readSecurityIdentitySync(
	fs: Pick<FsService, 'exists' | 'readTextSync'>,
	rootDir?: string,
): SecurityIdentityDoc {
	const path = securityIdentityPath(rootDir)
	if (!fs.exists(path)) return emptyDoc()
	return parseDoc(fs.readTextSync(path))
}

export async function readSecurityIdentity(
	fs: Pick<FsService, 'readText'>,
	rootDir?: string,
): Promise<SecurityIdentityDoc> {
	const path = securityIdentityPath(rootDir)
	try {
		return parseDoc(await fs.readText(path))
	} catch (error) {
		if (isMissing(error)) return emptyDoc()
		throw error
	}
}

export async function writeSecurityIdentity(
	fs: Pick<FsService, 'unlink' | 'writeTextAtomic'>,
	doc: SecurityIdentityDoc,
	rootDir?: string,
): Promise<void> {
	const path = securityIdentityPath(rootDir)
	const normalized = normalizeDoc(doc)
	if (!hasMaterial(normalized)) {
		await fs.unlink(path)
		return
	}
	await fs.writeTextAtomic(path, `${JSON.stringify(normalized, null, 2)}\n`)
}

export async function updateSecurityIdentity(
	fs: Pick<FsService, 'readText' | 'unlink' | 'writeTextAtomic'>,
	update: (current: SecurityIdentityDoc) => SecurityIdentityDoc,
	rootDir?: string,
): Promise<SecurityIdentityDoc> {
	const next = normalizeDoc(update(await readSecurityIdentity(fs, rootDir)))
	await writeSecurityIdentity(fs, next, rootDir)
	return next
}
