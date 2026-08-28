import { describe, expect, it } from 'vitest'
import { hashPassword, parsePasswordRecord, verifyPassword } from '../src/password.ts'
import {
	createTotpSecret,
	generateTotpForTesting,
	parseTotpRecord,
	verifyTotp,
} from '../src/totp.ts'

describe('password credentials', () => {
	it('stores only a bounded scrypt verifier and compares asynchronously', async () => {
		const record = await hashPassword('correct horse battery staple')
		expect(record).toMatchObject({ algorithm: 'scrypt', n: 32_768, r: 8, p: 1 })
		expect(JSON.stringify(record)).not.toContain('correct horse')
		expect(parsePasswordRecord(record)).toEqual(record)
		await expect(verifyPassword('correct horse battery staple', record)).resolves.toBe(true)
		await expect(verifyPassword('incorrect password', record)).resolves.toBe(false)
	})

	it('rejects untrusted parameters instead of accepting attacker-selected scrypt cost', async () => {
		const record = await hashPassword('a sufficiently long password')
		expect(parsePasswordRecord({ ...record, n: 1_073_741_824 })).toBeUndefined()
		expect(parsePasswordRecord({ ...record, hash: 'bad' })).toBeUndefined()
		expect(parsePasswordRecord({ ...record, salt: `${record.salt}=` })).toBeUndefined()
		expect(parsePasswordRecord({ ...record, hash: `${record.hash}=` })).toBeUndefined()
	})
})

describe('TOTP credentials', () => {
	it('matches the RFC SHA-1 vector and prevents counter replay', () => {
		const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
		const now = 59_000
		const counter = verifyTotp('287082', { secret, lastAcceptedCounter: -1 }, now)
		expect(counter).toBe(1)
		expect(verifyTotp('287082', { secret, lastAcceptedCounter: counter! }, now)).toBeUndefined()
	})

	it('creates and validates fixed-size authenticator secrets', () => {
		const secret = createTotpSecret()
		const now = Date.now()
		const token = generateTotpForTesting(secret, now)
		const counter = verifyTotp(token, { secret, lastAcceptedCounter: -1 }, now)
		expect(counter).toBeTypeOf('number')
		expect(
			parseTotpRecord({
				algorithm: 'sha1',
				digits: 6,
				period: 30,
				secret,
				lastAcceptedCounter: counter,
			}),
		).toBeDefined()
	})
})
