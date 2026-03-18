import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

export function b64url(input: Buffer | string): string {
	const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input
	return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

export function b64urlDecode(input: string): Buffer {
	const padded = input.replaceAll('-', '+').replaceAll('_', '/')
	const pad = padded.length % 4 === 0 ? 0 : 4 - (padded.length % 4)
	return Buffer.from(`${padded}${'='.repeat(pad)}`, 'base64')
}

const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_KEYLEN = 32

export function hashPasswordScrypt(password: string): string {
	const salt = randomBytes(16)
	const key = scryptSync(password, salt, SCRYPT_KEYLEN, {
		N: SCRYPT_N,
		r: SCRYPT_R,
		p: SCRYPT_P,
		maxmem: 64 * 1024 * 1024,
	})
	return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${b64url(salt)}$${b64url(key)}`
}

export function verifyPasswordScrypt(password: string, stored: string): boolean {
	// format: scrypt$N$r$p$saltB64url$hashB64url
	const parts = stored.split('$')
	if (parts.length !== 6) return false
	const [kind, Nraw, rraw, praw, saltB64, hashB64] = parts
	if (kind !== 'scrypt') return false
	const N = Number(Nraw)
	const r = Number(rraw)
	const p = Number(praw)
	if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false
	if (!saltB64 || !hashB64) return false

	let salt: Buffer
	let expected: Buffer
	try {
		salt = b64urlDecode(saltB64)
		expected = b64urlDecode(hashB64)
	} catch {
		return false
	}
	if (!salt.length || !expected.length) return false

	let actual: Buffer
	try {
		actual = scryptSync(password, salt, expected.length, {
			N,
			r,
			p,
			maxmem: 64 * 1024 * 1024,
		})
	} catch {
		return false
	}

	try {
		if (actual.length !== expected.length) return false
		return timingSafeEqual(actual, expected)
	} catch {
		return false
	}
}
