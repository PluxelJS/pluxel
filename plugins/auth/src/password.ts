import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

const SCRYPT_N = 32_768
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_KEY_LENGTH = 32
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024
const SALT_BYTES = 16
const MAX_PASSWORD_BYTES = 1_024
const MAX_ACTIVE_HASHES = 4
const MAX_QUEUED_HASHES = 32

export type PasswordRecord = Readonly<{
	algorithm: 'scrypt'
	n: number
	r: number
	p: number
	keyLength: number
	salt: string
	hash: string
}>

export class PasswordInputError extends Error {
	override name = 'PasswordInputError'
}

export class PasswordHashBusyError extends Error {
	override name = 'PasswordHashBusyError'

	constructor() {
		super('Password verification is temporarily busy')
	}
}

class HashAdmission {
	private active = 0
	private readonly queue: Array<() => void> = []

	async run<T>(operation: () => Promise<T>): Promise<T> {
		await this.acquire()
		try {
			return await operation()
		} finally {
			this.release()
		}
	}

	private acquire(): Promise<void> {
		if (this.active < MAX_ACTIVE_HASHES) {
			this.active += 1
			return Promise.resolve()
		}
		if (this.queue.length >= MAX_QUEUED_HASHES) {
			return Promise.reject(new PasswordHashBusyError())
		}
		return new Promise((resolve) => this.queue.push(resolve))
	}

	private release(): void {
		const next = this.queue.shift()
		if (next) {
			next()
			return
		}
		this.active -= 1
	}
}

const admission = new HashAdmission()

function passwordBytes(password: string): Buffer {
	if (typeof password !== 'string') throw new PasswordInputError('Password must be a string')
	const bytes = Buffer.from(password, 'utf8')
	if (bytes.length === 0 || bytes.length > MAX_PASSWORD_BYTES) {
		throw new PasswordInputError('Password length is outside the supported range')
	}
	return bytes
}

function derive(password: Buffer, record: PasswordRecord): Promise<Buffer> {
	return admission.run(
		() =>
			new Promise<Buffer>((resolve, reject) => {
				scrypt(
					password,
					Buffer.from(record.salt, 'base64url'),
					record.keyLength,
					{
						N: record.n,
						r: record.r,
						p: record.p,
						maxmem: SCRYPT_MAX_MEMORY,
					},
					(error, key) => {
						if (error) reject(error)
						else resolve(Buffer.from(key))
					},
				)
			}),
	)
}

export async function hashPassword(password: string): Promise<PasswordRecord> {
	if (password.length < 12)
		throw new PasswordInputError('Password must contain at least 12 characters')
	const bytes = passwordBytes(password)
	const record: PasswordRecord = {
		algorithm: 'scrypt',
		n: SCRYPT_N,
		r: SCRYPT_R,
		p: SCRYPT_P,
		keyLength: SCRYPT_KEY_LENGTH,
		salt: randomBytes(SALT_BYTES).toString('base64url'),
		hash: '',
	}
	const hash = await derive(bytes, record)
	return Object.freeze({ ...record, hash: hash.toString('base64url') })
}

export async function verifyPassword(password: string, record: PasswordRecord): Promise<boolean> {
	let bytes: Buffer
	try {
		bytes = passwordBytes(password)
	} catch {
		return false
	}
	const expected = Buffer.from(record.hash, 'base64url')
	const actual = await derive(bytes, record)
	return expected.length === actual.length && timingSafeEqual(expected, actual)
}

export function parsePasswordRecord(value: unknown): PasswordRecord | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
	const record = value as Partial<Record<keyof PasswordRecord, unknown>>
	if (
		record.algorithm !== 'scrypt' ||
		record.n !== SCRYPT_N ||
		record.r !== SCRYPT_R ||
		record.p !== SCRYPT_P ||
		record.keyLength !== SCRYPT_KEY_LENGTH ||
		typeof record.salt !== 'string' ||
		typeof record.hash !== 'string'
	) {
		return undefined
	}
	if (!/^[A-Za-z0-9_-]{22}$/.test(record.salt) || !/^[A-Za-z0-9_-]{43}$/.test(record.hash)) {
		return undefined
	}
	const salt = Buffer.from(record.salt, 'base64url')
	const hash = Buffer.from(record.hash, 'base64url')
	if (
		salt.length !== SALT_BYTES ||
		hash.length !== SCRYPT_KEY_LENGTH ||
		salt.toString('base64url') !== record.salt ||
		hash.toString('base64url') !== record.hash
	) {
		return undefined
	}
	return Object.freeze({
		algorithm: 'scrypt',
		n: SCRYPT_N,
		r: SCRYPT_R,
		p: SCRYPT_P,
		keyLength: SCRYPT_KEY_LENGTH,
		salt: record.salt,
		hash: record.hash,
	})
}

export function normalizeUsername(value: string): string | undefined {
	const normalized = value.trim().toLowerCase()
	return /^[a-z0-9][a-z0-9._@-]{0,63}$/.test(normalized) ? normalized : undefined
}

export function usernameMatches(candidate: string, expected: string): boolean {
	const left = createHash('sha256').update(candidate).digest()
	const right = createHash('sha256').update(expected).digest()
	return timingSafeEqual(left, right)
}
