import type {
	AuthenticationResponseJSON,
	PublicKeyCredentialCreationOptionsJSON,
	PublicKeyCredentialRequestOptionsJSON,
	RegistrationResponseJSON,
} from '@simplewebauthn/server'

export type VerificationMode = 'enforce' | 'bypass'
export type VerificationMethod = 'password' | 'otp' | 'passkey'

export type VerificationPasswordUserStored = {
	username: string
	passwordHash: string
}

export type VerificationOtpUserStored = {
	username: string
	otpSecret: string
}

export type VerificationPasskeyUserStored = {
	username: string
	credentialId: string
	publicKey: string
	counter: number
	transports?: string[]
}

export type VerificationPasswordConfig = {
	mode: VerificationMode
	method: 'password'
	users?: VerificationPasswordUserStored[]
}

export type VerificationOtpConfig = {
	mode: VerificationMode
	method: 'otp'
	users?: VerificationOtpUserStored[]
}

export type VerificationPasskeyConfig = {
	mode: VerificationMode
	method: 'passkey'
	users?: VerificationPasskeyUserStored[]
}

export type VerificationConfig =
	| VerificationPasswordConfig
	| VerificationOtpConfig
	| VerificationPasskeyConfig

export type VerificationUser = {
	username: string
}

export type VerificationUserDeleteInput = {
	username: string
}

export type VerificationPasswordUserUpsertInput = {
	username: string
	password: string
}

export type VerificationOtpUserProvisionInput = {
	username: string
}

export type VerificationOtpEnrollment = {
	username: string
	secret: string
	otpauthUrl: string
}

export type VerificationPasswordCredentials = {
	username: string
	password: string
}

export type VerificationOtpCredentials = {
	username: string
	code: string
}

export type VerificationRequestContext = {
	request?: Request
	headers?: Headers
	url?: string
}

export type VerificationAuthorizeInput = VerificationRequestContext

export type VerificationPasswordVerifyInput = VerificationRequestContext & {
	credentials: VerificationPasswordCredentials
}

export type VerificationOtpVerifyInput = VerificationRequestContext & {
	credentials: VerificationOtpCredentials
}

export type VerificationReason = 'bypass' | 'verification_required' | 'misconfigured'

export type VerificationState = {
	allow: boolean
	reason?: VerificationReason
}

export type VerificationVerifyResult = VerificationState & {
	cookie?: string
}

export type VerificationAdminState = {
	mode: VerificationMode
	method: VerificationMethod
	users: VerificationUser[]
} & VerificationState

export type VerificationOtpProvisionResult = {
	verification: VerificationAdminState
	enrollment: VerificationOtpEnrollment
}

export type VerificationPasskeyRegistrationStartInput = {
	username: string
}

export type VerificationPasskeyRegistrationOptions = PublicKeyCredentialCreationOptionsJSON

export type VerificationPasskeyRegistrationFinishInput = VerificationRequestContext & {
	username: string
	credential: RegistrationResponseJSON
}

export type VerificationPasskeyAuthenticationStartInput = {
	username: string
}

export type VerificationPasskeyAuthenticationOptions = PublicKeyCredentialRequestOptionsJSON

export type VerificationPasskeyAuthenticationFinishInput = VerificationRequestContext & {
	username: string
	credential: AuthenticationResponseJSON
}
