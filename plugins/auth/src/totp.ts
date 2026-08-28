import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const SECRET_BYTES = 20
const PERIOD_SECONDS = 30
const DIGITS = 6

export type TotpRecord = Readonly<{
	algorithm: 'sha1'
	digits: 6
	period: 30
	secret: string
	lastAcceptedCounter: number
}>

function encodeBase32(bytes: Uint8Array): string {
	let bits = 0
	let value = 0
	let output = ''
	for (const byte of bytes) {
		value = (value << 8) | byte
		bits += 8
		while (bits >= 5) {
			output += ALPHABET[(value >>> (bits - 5)) & 31]
			bits -= 5
		}
	}
	if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31]
	return output
}

function decodeBase32(input: string): Buffer | undefined {
	if (!/^[A-Z2-7]{32}$/.test(input)) return undefined
	let bits = 0
	let value = 0
	const output: number[] = []
	for (const char of input) {
		const index = ALPHABET.indexOf(char)
		if (index < 0) return undefined
		value = (value << 5) | index
		bits += 5
		if (bits >= 8) {
			output.push((value >>> (bits - 8)) & 255)
			bits -= 8
		}
	}
	return output.length === SECRET_BYTES ? Buffer.from(output) : undefined
}

function tokenAt(secret: Buffer, counter: number): string {
	const message = Buffer.alloc(8)
	message.writeBigUInt64BE(BigInt(counter))
	const digest = createHmac('sha1', secret).update(message).digest()
	const offset = digest[digest.length - 1]! & 0x0f
	const value =
		(((digest[offset]! & 0x7f) << 24) |
			(digest[offset + 1]! << 16) |
			(digest[offset + 2]! << 8) |
			digest[offset + 3]!) %
		10 ** DIGITS
	return value.toString().padStart(DIGITS, '0')
}

export function createTotpSecret(): string {
	return encodeBase32(randomBytes(SECRET_BYTES))
}

export function totpProvisioningUri(input: {
	secret: string
	username: string
	issuer?: string
}): string {
	const issuer = input.issuer ?? 'Pluxel'
	const label = `${issuer}:${input.username}`
	const params = new URLSearchParams({
		secret: input.secret,
		issuer,
		algorithm: 'SHA1',
		digits: String(DIGITS),
		period: String(PERIOD_SECONDS),
	})
	return `otpauth://totp/${encodeURIComponent(label)}?${params}`
}

export function verifyTotp(
	token: string,
	record: Pick<TotpRecord, 'secret' | 'lastAcceptedCounter'>,
	nowMs: number = Date.now(),
): number | undefined {
	if (!/^\d{6}$/.test(token)) return undefined
	const secret = decodeBase32(record.secret)
	if (!secret) return undefined
	const current = Math.floor(nowMs / 1_000 / PERIOD_SECONDS)
	for (const counter of [current - 1, current, current + 1]) {
		if (counter <= record.lastAcceptedCounter || counter < 0) continue
		const expected = Buffer.from(tokenAt(secret, counter), 'ascii')
		const actual = Buffer.from(token, 'ascii')
		if (timingSafeEqual(expected, actual)) return counter
	}
	return undefined
}

export function generateTotpForTesting(secret: string, nowMs: number = Date.now()): string {
	const decoded = decodeBase32(secret)
	if (!decoded) throw new TypeError('Invalid TOTP secret')
	return tokenAt(decoded, Math.floor(nowMs / 1_000 / PERIOD_SECONDS))
}

export function parseTotpRecord(value: unknown): TotpRecord | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
	const record = value as Partial<Record<keyof TotpRecord, unknown>>
	if (
		record.algorithm !== 'sha1' ||
		record.digits !== DIGITS ||
		record.period !== PERIOD_SECONDS ||
		typeof record.secret !== 'string' ||
		!decodeBase32(record.secret) ||
		typeof record.lastAcceptedCounter !== 'number' ||
		!Number.isSafeInteger(record.lastAcceptedCounter) ||
		record.lastAcceptedCounter < -1
	) {
		return undefined
	}
	return Object.freeze({
		algorithm: 'sha1',
		digits: DIGITS,
		period: PERIOD_SECONDS,
		secret: record.secret,
		lastAcceptedCounter: record.lastAcceptedCounter,
	})
}
