import { describe, expect, it } from 'vitest'
import {
	buildPasskeyAuthenticationOptions,
	buildPasskeyRegistrationOptions,
} from '../../src/services/verification/passkey'

describe('passkey helper', () => {
	it('builds registration options with the fixed host passkey policy', async () => {
		const options = await buildPasskeyRegistrationOptions({
			rpId: 'ops.local',
			rpName: 'Pluxel',
			username: 'ops',
		})

		expect(options).toMatchObject({
			rp: {
				id: 'ops.local',
				name: 'Pluxel',
			},
			user: {
				name: 'ops',
				displayName: 'ops',
			},
			attestation: 'none',
			authenticatorSelection: {
				residentKey: 'preferred',
				userVerification: 'required',
			},
		})
		expect(options.challenge).toEqual(expect.any(String))
		expect(options.user.id).toEqual(expect.any(String))
		expect(options.pubKeyCredParams).toEqual(
			expect.arrayContaining([expect.objectContaining({ type: 'public-key', alg: -7 })]),
		)
	})

	it('builds authentication options for the single stored credential only', async () => {
		const options = await buildPasskeyAuthenticationOptions({
			rpId: 'ops.local',
			user: {
				username: 'ops',
				credentialId: 'credential-1',
				publicKey: 'AQIDBA',
				counter: 7,
				transports: ['internal'],
			},
		})

		expect(options).toMatchObject({
			rpId: 'ops.local',
			userVerification: 'required',
			allowCredentials: [{ id: 'credential-1', transports: ['internal'] }],
		})
		expect(options.challenge).toEqual(expect.any(String))
	})
})
