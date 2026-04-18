import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
	type AuthenticatorTransportFuture,
} from '@simplewebauthn/server'
import {
	b64url,
	b64urlDecode,
} from './password'
import type {
	VerificationPasskeyAuthenticationFinishInput,
	VerificationPasskeyAuthenticationOptions,
	VerificationPasskeyRegistrationFinishInput,
	VerificationPasskeyRegistrationOptions,
	VerificationPasskeyUserStored,
} from './types'

const PASSKEY_ES256_ALG = -7

function normalizeTransports(value: string[] | undefined): AuthenticatorTransportFuture[] | undefined {
	if (!value || value.length === 0) return undefined
	return value as AuthenticatorTransportFuture[]
}

function toFixedUint8Array(value: Uint8Array): Uint8Array<ArrayBuffer> {
	const buffer = new ArrayBuffer(value.byteLength)
	new Uint8Array(buffer).set(value)
	return new Uint8Array(buffer)
}

export async function buildPasskeyRegistrationOptions(params: {
	rpId: string
	rpName: string
	username: string
}): Promise<VerificationPasskeyRegistrationOptions> {
	return await generateRegistrationOptions({
		rpID: params.rpId,
		rpName: params.rpName,
		userName: params.username,
		userDisplayName: params.username,
		userID: Buffer.from(params.username, 'utf8'),
		attestationType: 'none',
		authenticatorSelection: {
			residentKey: 'preferred',
			userVerification: 'required',
		},
		supportedAlgorithmIDs: [PASSKEY_ES256_ALG],
	})
}

export async function verifyPasskeyRegistration(params: {
	expectedChallenge: string
	expectedOrigin: string
	rpId: string
	input: VerificationPasskeyRegistrationFinishInput
}): Promise<VerificationPasskeyUserStored> {
	const verification = await verifyRegistrationResponse({
		response: params.input.credential,
		expectedChallenge: params.expectedChallenge,
		expectedOrigin: params.expectedOrigin,
		expectedRPID: params.rpId,
		requireUserVerification: true,
		supportedAlgorithmIDs: [PASSKEY_ES256_ALG],
	})

	if (!verification.verified || !verification.registrationInfo) {
		throw new Error('Passkey registration verification failed.')
	}

	return {
		username: params.input.username,
		credentialId: verification.registrationInfo.credential.id,
		publicKey: b64url(Buffer.from(verification.registrationInfo.credential.publicKey)),
		counter: verification.registrationInfo.credential.counter,
		...(verification.registrationInfo.credential.transports?.length
			? { transports: verification.registrationInfo.credential.transports }
			: {}),
	}
}

export async function buildPasskeyAuthenticationOptions(params: {
	rpId: string
	user: VerificationPasskeyUserStored
}): Promise<VerificationPasskeyAuthenticationOptions> {
	return await generateAuthenticationOptions({
		rpID: params.rpId,
		userVerification: 'required',
		allowCredentials: [
			{
				id: params.user.credentialId,
				...(params.user.transports?.length
					? { transports: normalizeTransports(params.user.transports) }
					: {}),
			},
		],
	})
}

export async function verifyPasskeyAuthentication(params: {
	expectedChallenge: string
	expectedOrigin: string
	rpId: string
	user: VerificationPasskeyUserStored
	input: VerificationPasskeyAuthenticationFinishInput
}): Promise<VerificationPasskeyUserStored> {
	const verification = await verifyAuthenticationResponse({
		response: params.input.credential,
		expectedChallenge: params.expectedChallenge,
		expectedOrigin: params.expectedOrigin,
		expectedRPID: params.rpId,
		requireUserVerification: true,
		credential: {
			id: params.user.credentialId,
			publicKey: toFixedUint8Array(b64urlDecode(params.user.publicKey)),
			counter: params.user.counter,
			...(params.user.transports?.length
				? { transports: normalizeTransports(params.user.transports) }
				: {}),
		},
	})

	if (!verification.verified) {
		throw new Error('Passkey authentication verification failed.')
	}

	return {
		...params.user,
		counter: verification.authenticationInfo.newCounter,
	}
}
