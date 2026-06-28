import { resolve } from 'pathe'
import type { FsService } from '../fs/FsService'

export type SecurityIdentityDoc = {
	version: 1
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

function normalizeDoc(input: unknown): SecurityIdentityDoc {
	if (!input || typeof input !== 'object') return emptyDoc()
	const source = input as {
		vault?: { hostIdentity?: unknown; deployRecipients?: unknown }
	}
	const hostIdentity = trimOrUndefined(source.vault?.hostIdentity)
	const deployRecipients = normalizeRecipients(source.vault?.deployRecipients)

	const doc: SecurityIdentityDoc = {
		version: 1,
	}

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
