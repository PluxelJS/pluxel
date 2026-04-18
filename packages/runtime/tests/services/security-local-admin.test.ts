import { readFile } from 'node:fs/promises'
import { resolve } from 'pathe'
import { createFixture } from '@pluxel/test/fixtures'
import { describe, expect, it } from 'vitest'
import {
	deleteLocalVerificationUser,
	describeLocalVerification,
	resetLocalVerification,
	setLocalVerificationMethod,
	setLocalVerificationMode,
	upsertLocalVerificationPasswordUser,
} from '../../src/services/security/local-admin'

describe('local security admin', () => {
	it('manages offline verification users in identity.json without a running host', async () => {
		await using fixture = await createFixture({})

		expect(await describeLocalVerification(fixture.path)).toMatchObject({
			mode: 'enforce',
			method: 'password',
			users: [],
		})

		await setLocalVerificationMode(fixture.path, 'bypass')
		await upsertLocalVerificationPasswordUser(fixture.path, {
			username: 'ops',
			password: 'secret',
		})
		await upsertLocalVerificationPasswordUser(fixture.path, {
			username: 'sre',
			password: 'secret-2',
		})

		expect(await describeLocalVerification(fixture.path)).toMatchObject({
			mode: 'bypass',
			method: 'password',
			users: [{ username: 'ops' }, { username: 'sre' }],
		})

		const raw = JSON.parse(
			await readFile(resolve(fixture.path, 'data/security/identity.json'), 'utf8'),
		) as {
			verification?: {
				users?: Array<{ username: string; passwordHash: string }>
			}
		}
		expect(raw.verification?.users).toHaveLength(2)
		expect(raw.verification?.users?.[0]?.passwordHash).toContain('scrypt$')

		await deleteLocalVerificationUser(fixture.path, 'ops')
		expect(await describeLocalVerification(fixture.path)).toMatchObject({
			users: [{ username: 'sre' }],
		})

		await setLocalVerificationMethod(fixture.path, 'otp')
		expect(await describeLocalVerification(fixture.path)).toMatchObject({
			method: 'otp',
			users: [],
		})

		await resetLocalVerification(fixture.path)
		expect(await describeLocalVerification(fixture.path)).toMatchObject({
			mode: 'bypass',
			method: 'otp',
			users: [],
		})
	})
})
